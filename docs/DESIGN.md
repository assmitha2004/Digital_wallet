# PayLedger design — in plain English

This document explains every important decision in the project and **why** it was made.
Read it before an interview. Each section ends with the one sentence to remember.

---

## 1. Money is stored as whole paise, never as decimals

Computers store decimal numbers like 0.1 in binary, and they are not exact.
In JavaScript, `0.1 + 0.2` gives `0.30000000000000004`.
For money, a tiny error repeated a million times becomes a real loss.

So PayLedger stores **paise** as whole numbers (`BIGINT`):

| User types | Stored as |
|---|---|
| `"250.50"` | `25050` |
| `"0.01"` | `1` |

The amount arrives as a **string**. `money.js` checks it with a pattern (digits, then at most two
decimal digits) and converts it without any decimal maths: `"250.50"` → `250 × 100 + 50`.
Anything like `"1.999"` or `"-5"` is rejected.

> **Remember:** "Money is integer paise. Floats are never used for money."

---

## 2. Double-entry ledger

Every payment writes **two** ledger rows with the same amount:

| Payment | Ledger rows written |
|---|---|
| Asha sends Bala ₹100 | DEBIT Asha ₹100, CREDIT Bala ₹100 |
| Asha adds ₹500 | DEBIT System wallet ₹500, CREDIT Asha ₹500 |

Because every DEBIT has a matching CREDIT, **money is never created or destroyed**. Money only moves.

Where does top-up money come from? From a special **SYSTEM wallet** (id 1). It is the only wallet
allowed to go negative. Its negative balance equals all the money users have added.
That is why the sum of all wallet balances is always exactly **0** — and the reconcile check tests this.

The `wallets.balance_paise` column is a **cache** so we can read a balance quickly.
The ledger is the truth. `verifyWallet()` and `npm run reconcile` check that the cache equals the ledger.

Ledger rows are **never updated or deleted**. A refund would be a *new* pair of rows going the other way.
This gives a full audit trail, like a bank statement.

> **Remember:** "Every payment writes a matching debit and credit in one transaction, so the books always balance, and I can prove it with a reconcile query."

---

## 3. Database transactions (all or nothing)

A transfer changes 5 things: two balances, one transaction row, two ledger rows.
If the server crashes after changing only the sender's balance, money disappears.

So all 5 writes happen inside one **database transaction** (`withTransaction` in `db.js`):
`BEGIN` → writes → `COMMIT`. If anything throws, we `ROLLBACK` and **nothing** is saved.

> **Remember:** "A transfer is one database transaction: either every row is written or none is."

---

## 4. Race conditions and `SELECT … FOR UPDATE`

A **race condition** is when the result depends on which request happens to run first.

The bug, step by step. Asha has ₹100. Two ₹60 transfers arrive at the same time:

```
Request 1: read balance → ₹100   ✔ enough
Request 2: read balance → ₹100   ✔ enough      (request 1 has not written yet)
Request 1: write balance = ₹40
Request 2: write balance = ₹40
Result: ₹120 sent from a ₹100 wallet, and the balance says ₹40.
```

The fix is a **row lock**. `SELECT … FOR UPDATE` tells MySQL: "I am about to change this row;
anyone else who wants to lock it must wait until I commit."

```
Request 1: SELECT … FOR UPDATE → gets the lock, sees ₹100, sends ₹60, COMMIT (₹40)
Request 2: SELECT … FOR UPDATE → waits … then sees ₹40 → "Insufficient funds"
```

The important detail: **the balance check happens after taking the lock.** Checking first and
locking later would still allow the bug.

`npm run race-demo` measures this: without the lock, 50 simultaneous ₹10 transfers from a ₹100
wallet were *all* accepted and ₹440 appeared from nowhere. With the lock, exactly 10 were accepted.

Why not just `UPDATE wallets SET balance = balance - 60 WHERE id = ? AND balance >= 60`?
That single statement is also safe and is a fine answer. PayLedger uses `FOR UPDATE` because a
transfer needs **several** checks (balance, daily limit) and writes the balance-after value into
the ledger, so it needs a stable view of the row for the whole transaction.

> **Remember:** "I lock the wallet row with SELECT FOR UPDATE and check the balance after the lock, so two requests cannot both spend the same money."

---

## 5. Deadlocks and lock ordering

A **deadlock** is two requests each waiting for a lock the other one holds:

```
Transfer X (Asha → Bala): locks Asha, then waits for Bala
Transfer Y (Bala → Asha): locks Bala, then waits for Asha
Both wait forever.
```

MySQL notices this and kills one of them with error `ER_LOCK_DEADLOCK`.

The fix: **always lock wallets in the same order — lowest id first.** Then both transfers try to
lock Asha first; one waits at the start, and no circle of waiting can form.

`npm run race-demo` measures this: locking "sender first" caused 50 deadlocks in 100 transfers;
locking "lowest id first" caused 0.

There is also a small **retry** (`withRetry` in `db.js`): if MySQL still reports a deadlock or a
lock-wait timeout, we try the whole transaction again up to 3 times. This is safe because the
killed transaction wrote nothing.

> **Remember:** "I prevent deadlocks by locking rows in a fixed order, and retry the rare one MySQL still reports."

---

## 6. Idempotency — a retry never pays twice

**Idempotent** means: doing it twice has the same effect as doing it once.

The problem: the phone sends "pay ₹500", the server pays, but the response is lost on the way back.
The phone does not know if it worked, so it retries. Without protection, the user pays ₹1,000.

The fix: the client creates a random **Idempotency-Key** (a UUID) for each payment and sends it as a
header. A retry sends the **same** key. (Stripe and Razorpay use the same idea.)

How the server uses it (`idempotency.js`), all inside one database transaction:

1. `INSERT` the key into `idempotency_keys`, which has a **UNIQUE** index on `(user_id, idem_key)`.
2. If the insert works → this is a new payment → do it → save the response on the key row → `COMMIT`.
3. If the insert fails with "duplicate key" → this key was used before → return the **saved** response
   with the header `Idempotent-Replayed: true`. No money moves.

What if two copies of the same request arrive **at the same time**? The second `INSERT` hits the
unique index and MySQL makes it **wait** until the first transaction finishes. Then it sees the
duplicate and replays. The test fires 20 copies at once and checks that exactly one transfer happened.

Three details worth knowing:

- **Same key, different body** (e.g. a different amount) → `422 IDEMPOTENCY_KEY_REUSED`. We compare a
  SHA-256 hash of the request body.
- **Errors are saved too.** If the first try failed with "insufficient funds", a retry gets the same
  error — even if the user has added money since. A retry must never turn into a *new* payment.
- **Crash safety.** The key is inserted in the same transaction as the payment. If the server dies
  mid-way, both roll back together, so the key is free and a retry runs normally. There is no
  "stuck" state to clean up.

The frontend follows the same rules: it keeps the key when there was **no answer** (so "Retry" is
safe) and makes a new key once the server **did** answer.

> **Remember:** "The client sends an idempotency key; a unique index makes sure the payment runs at most once, and retries get the saved response."

---

## 7. Limits

| Limit | Value | Where checked |
|---|---|---|
| Per top-up | ₹50,000 | before locking |
| Per transfer | ₹1,00,000 | before locking |
| Per day sent | ₹2,00,000 (India time) | **after** locking the sender's wallet |

The daily limit is checked after the lock for the same reason as the balance: two transfers at once
must not both see "under the limit". The query uses the index `(from_wallet_id, type, created_at)`.

---

## 8. Security

- **Passwords** are hashed with **bcrypt** (slow on purpose, with a salt). The plain password is never stored.
- **JWT**: after login the server signs a token with a secret. Each request sends it; the server checks the signature. No session table needed.
- Login gives the **same error** for "no such email" and "wrong password", so attackers cannot discover which emails exist.
- **Rate limiting**: 10 login attempts per 15 minutes per IP.
- **SQL injection** is impossible because every query uses **parameters** (`?`), never string concatenation.
- **Validation** with zod on every request body.
- Users can only see **their own** wallet: the wallet is always looked up from the token's user id, never from a URL parameter.
- Public transaction ids are **UUIDs**, so nobody can guess other people's transaction numbers.
- `helmet` sets safe HTTP headers.

---

## 9. Cursor pagination for history

Page-number paging (`OFFSET 40`) has two problems: MySQL still reads and throws away the first 40 rows,
and if a new payment arrives while you scroll, items shift and you see duplicates.

Cursor paging says "give me 20 entries **older than id 1234**": `WHERE wallet_id = ? AND id < ? ORDER BY id DESC`.
With the index `(wallet_id, id)` MySQL jumps straight there. We fetch `limit + 1` rows to know if there is a next page.

---

## 10. Trade-offs and limits (be honest about these)

- **Hot row:** every top-up locks the single SYSTEM wallet, so top-ups run one at a time. Fine at this
  scale; a bigger system would split it into several funding wallets or skip caching its balance.
- **Rate limiter is in memory**, so on serverless each instance counts separately. Production would use Redis.
- **No refresh tokens**; the access token lasts 2 hours.
- **Idempotency keys are kept forever.** Production would delete them after ~24 hours with a scheduled job.
- **Top-ups are simulated.** A real gateway would confirm payment with a signed webhook first.
- Single currency (INR).
