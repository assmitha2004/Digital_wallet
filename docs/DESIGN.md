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
- **JWT access tokens** (15 minutes) plus rotating refresh tokens in an httpOnly cookie: see section 10.
- Login gives the **same error** for "no such email" and "wrong password", so attackers cannot discover which emails exist.
- **Rate limiting**: 10 login attempts per 15 minutes per IP, 300 API calls per minute per IP, 30 payments per minute per user (shared through Redis when configured). Plus account lockout and 2FA (section 11).
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

## 10. Sessions: short access token + rotating refresh token

Two tokens, each doing one job:

| Token | Lives | Stored where | Why |
|---|---|---|---|
| **Access token** (JWT) | 15 minutes | a JavaScript variable (memory only) | Sent on every API call. Short life limits the damage if it leaks. |
| **Refresh token** (random 256-bit string) | 30 days | an **httpOnly, SameSite=Strict** cookie, path `/api/auth` | Page JavaScript can never read it (so XSS cannot steal it); the browser only sends it to the auth endpoints. |

The database stores only the **SHA-256 hash** of each refresh token, so a database leak does not leak sessions.

**Rotation.** Every refresh revokes the old token and issues a new one in the same "family". So a refresh token
works exactly once.

**Theft detection.** If a token that was already used shows up again, two parties have a copy: the real user and
an attacker. The server cannot tell which is which, so it revokes the **whole family** and both must log in again.
The event is written to the audit log.

**Two tabs at once.** Two tabs refreshing with the same token at the same moment would look like theft. The token
row is locked `FOR UPDATE`, so one wins; the other gets `SESSION_ALREADY_REFRESHED` if it arrives within 30 seconds
of the rotation, and the session survives. The frontend also shares one refresh promise per tab.

**Log out everywhere** revokes all refresh tokens *and* bumps `users.token_version`. Access tokens carry the version,
and `requireAuth` checks it with one primary-key lookup, so even unexpired access tokens stop working immediately.

**CSRF.** Cookie-authenticated endpoints need SameSite=Strict *and* a custom `X-PayLedger-Client` header, which another
site's form cannot send.

> **Remember:** "Short-lived access token in memory, rotating refresh token in an httpOnly cookie, stored hashed. Reusing an old refresh token kills the whole session family."

---

## 11. Login protection and two-step verification

**Lockout.** 5 wrong attempts lock the account for 15 minutes. The counter is updated in **one atomic `UPDATE`**, so
12 simultaneous wrong guesses cannot all slip under the limit (a test fires 12 at once). A per-IP rate limit (10 per
15 minutes) also slows guessing across many accounts.

**Same answer for unknown emails.** An unknown email gets the same error *and the same timing* as a wrong password
(we bcrypt-compare against a dummy hash), so attackers cannot discover which emails are registered.

**TOTP (RFC 6238)**, the 6-digit codes from Google Authenticator or Authy, written with `node:crypto` only:
`code = HMAC-SHA1(secret, floor(time / 30))`, truncated to 6 digits. We accept one 30-second step either side for
clock drift. A test checks the RFC's official test vectors.

**A code works once.** `users.totp_last_step` stores the last accepted step, and a code is accepted only with a
conditional `UPDATE ... WHERE totp_last_step < ?`. Two requests with the same code: only one `UPDATE` matches a row.

**Step-up for large payments.** Transfers of ₹10,000 or more need a fresh code, so a stolen session alone cannot empty
a wallet. The code is **left out of the idempotency hash**: a retry of the same payment with a newer code is still the
same payment and is replayed, not charged twice.

> **Remember:** "Lockout is one atomic UPDATE. TOTP codes are single-use via a conditional UPDATE on the last step. Big transfers need a code, and the code is excluded from the idempotency hash."

---

## 12. Refunds

A refund is a **new REFUND transaction** going the other way, linked by `refund_of_id`. The original is never edited,
so the ledger stays append-only.

Only the person who **received** a transfer can refund it (fully or in parts). The danger is two refunds at once
together returning more than was paid. So the refund first locks **the original transaction row** `FOR UPDATE`, then
sums earlier refunds, then locks the two wallets in id order. Ten simultaneous ₹20 refunds of a ₹100 payment: exactly
five succeed (tested). `reconcile` also checks no payment is over-refunded.

**Lock order matters here too.** My first version locked the original with a `JOIN` to the wallets table. That also
locked a wallet row, out of id order, which could deadlock with a transfer. The fix: lock only the transaction row,
then wallets in id order. Every path takes locks in the same order: *business row → wallets (by id)*.

> **Remember:** "Refunds are new ledger entries. Locking the original payment row serialises refunds of the same payment, so they can never exceed it."

---

## 13. Payment requests

"Please pay me ₹300." The payer can pay or decline; the requester can cancel. The request row is locked `FOR UPDATE`
before acting, so "pay" and "cancel" at the same moment take turns: exactly one wins (tested). Paying runs the normal
transfer code (same limits, locks and 2FA step-up). A user can have at most 20 open requests, so nobody can be spammed.

---

## 14. Razorpay top-ups and webhooks

1. The server creates a Razorpay order **outside any database transaction** (never hold row locks while waiting on the
   network) and remembers it in `gateway_orders`.
2. The browser opens Razorpay Checkout; the user pays.
3. Razorpay tells us **twice, in any order**: the browser posts Checkout's signed result, and Razorpay's server sends a
   signed **webhook**.
4. Whichever arrives first credits the wallet. It locks the order row `FOR UPDATE`, credits, and marks it `PAID` in one
   transaction. The second finds `PAID` and does nothing. `transactions.external_ref` is UNIQUE as a second guard.

**Signatures.** Checkout: `HMAC-SHA256(order_id|payment_id, key_secret)`. Webhook: `HMAC-SHA256(raw body, webhook_secret)`.
The webhook route reads the **raw bytes** (re-serialising parsed JSON can change them), and signatures are compared with
`crypto.timingSafeEqual`. Bad signatures get 400 and an audit entry; valid events we do not handle get 200 so Razorpay
stops retrying. A webhook whose amount does not match the order credits nothing.

> **Remember:** "Two confirmations, one credit: the order row lock plus a UNIQUE gateway payment id."

---

## 15. Admin, audit log and frozen wallets

- `users.role` is `USER` or `ADMIN`; admin routes check it on every request. Admin is never seeded with a public
  password: `ADMIN_EMAIL` promotes an existing account, or `npm run make-admin -- email`.
- **Freezing** sets `wallets.status = 'FROZEN'` while holding the wallet's row lock. Payments read the status from the
  **locked** row, so a payment cannot slip through between "check" and "write".
- **Audit log** (`audit_logs`, append-only): logins, failures, lockouts, token theft, 2FA changes, refunds, freezes,
  gateway credits, rejected webhooks, each with actor, target, IP and **request id**. Events tied to a state change
  are written **in the same transaction**, so the audit row exists if and only if the change happened.

---

## 16. Operations

| Need | How |
|---|---|
| **Find everything about one request** | Every response has an `X-Request-Id` (kept from a load balancer if present). It is in the JSON log line, in 500 error bodies and in audit rows. |
| **Logs** | pino JSON logs; passwords, codes, cookies and auth headers are redacted before writing. |
| **Is it alive / ready?** | `/api/health` (process up, no dependencies, so a slow DB never restarts healthy pods) and `/api/ready` (DB, all migrations applied, Redis; each check time-limited). |
| **Metrics** | `/api/metrics` for Prometheus: request duration by **route pattern** (`/transactions/:id/refunds`, never raw ids, which would explode label counts), payments by kind and outcome, process stats. Needs `METRICS_TOKEN` in production. |
| **Schema changes** | Numbered migrations recorded in `schema_migrations`. MySQL DDL is not transactional, so statements run one by one and "already exists" errors count as done: a half-applied migration can simply be re-run. All changes are additive, so old code keeps working during a deploy. |
| **Housekeeping** | A daily Vercel Cron calls `/api/internal/cleanup` (secret-protected): deletes idempotency keys older than 24 hours and long-expired refresh tokens, in batches of 1,000 so payments are never blocked by one huge DELETE. |
| **Shared rate limits** | With `REDIS_URL`, counters live in Redis and are shared by every instance. If Redis is down, requests are **allowed** (an outage of the limiter must not become an outage of payments). |
| **Deploys and restarts** | On SIGTERM the server stops accepting connections, lets running requests (a payment mid-transaction) finish, closes the DB pool and Redis, then exits (force-exit after 10 s). |
| **API docs** | OpenAPI 3.1 spec at `/api/openapi.json`, Swagger UI at `/api/docs`. A test fails if any route is missing from the spec. |

---

## 17. Statements

CSV and PDF for any range up to a year, with opening and closing balances, in India time. CSV cells that start with
`= + - @` get an apostrophe, because a note like `=HYPERLINK(...)` would otherwise run as a formula when opened in Excel
(**CSV injection**).

---

## 18. Trade-offs and limits (be honest about these)

- **Hot row:** every top-up locks the single SYSTEM wallet, so top-ups run one at a time. Fine at this
  scale; a bigger system would split it into several funding wallets or skip caching its balance.
- **Rate limits without Redis are per process.** Set `REDIS_URL` for shared limits (the live demo can use Upstash).
- **Idempotency keys expire after 24 hours.** A retry after that would be a new payment (the same window Stripe uses).
- **Lockout can be used to annoy:** someone who knows your email can lock you out for 15 minutes. The per-IP limit
  slows this; a production system might add a CAPTCHA after a few failures instead of a hard lock.
- **The refresh "two tabs" grace window** (30 s) means a token copied and replayed within 30 seconds of a refresh is
  rejected but does not revoke the session. A trade-off for not logging people out when two tabs refresh at once.
- **2FA has no recovery codes yet**; losing the phone means an admin must reset it.
- **Simulated top-ups** stay on for the public demo (`ALLOW_SIMULATED_TOPUPS=false` turns them off).
- **Gateway refunds** (sending money back to the card) are not built; refunds are wallet-to-wallet.
- **Single currency in practice.** Wallets have a currency column and transfers between different currencies are
  refused, but there is no FX conversion.
