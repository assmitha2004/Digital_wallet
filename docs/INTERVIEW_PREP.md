# PayLedger — interview preparation

Practise saying these answers out loud. Short answers first; go deeper only if they ask.
Every number here comes from this repo (`npm test`, `npm run race-demo`, `npm run benchmark`).

---

## The 30-second pitch

> "PayLedger is a full-stack digital wallet — React, Node.js with Express, and MySQL. Users add money
> and send it to each other by email. The focus was correctness under concurrency. Every payment is a
> double-entry ledger write inside one MySQL transaction. I lock wallet rows with SELECT FOR UPDATE in
> ascending id order, so there's no double-spending and no deadlocks, and every payment takes an
> idempotency key so a retry never charges twice. I proved it with tests against real MySQL — for
> example, 50 simultaneous ₹10 transfers from a ₹100 wallet: exactly 10 succeed. Without the lock,
> all 50 went through and ₹440 appeared from nowhere."

---

## Likely questions

**1. Why did you build this?**
At Barclays I saw how much banks care about every transaction being correct and auditable. I wanted to
understand the backend problems behind a payment app: race conditions, duplicate requests and keeping
the books balanced.

**2. Walk me through what happens when I send ₹100.**
The request has a JWT and an Idempotency-Key. Express validates the body with zod and converts "100"
to 10000 paise. Then, in one MySQL transaction: insert the idempotency key; look up the recipient;
lock both wallets with SELECT FOR UPDATE, lower id first; check balance and limits; update both
balances; insert one transaction row and two ledger rows (debit, credit); save the response on the
key; commit.

**3. What is a race condition? Show me one in your project.**
When the result depends on timing. Two transfers read the same balance before either writes, so both
pass the check. My race-demo shows it: without a lock, 50 of 50 transfers were accepted from ₹100.

**4. How does SELECT FOR UPDATE fix it?**
It takes an exclusive lock on the row until commit. A second transaction that wants the same row
waits. I check the balance *after* getting the lock, so the second one sees the updated balance.

**5. Could you have used an atomic UPDATE instead?**
Yes — `UPDATE ... SET balance = balance - ? WHERE id = ? AND balance >= ?` and check affected rows.
That's a valid alternative. I used FOR UPDATE because I also check a daily limit and record the
balance-after in the ledger, so I need a stable view of the row for the whole transaction.

**6. What is a deadlock and how did you avoid it?**
Two transactions each hold a lock the other needs. A→B and B→A at the same time is the classic case.
I always lock the lower wallet id first, so they queue instead of forming a cycle. Measured: locking
sender-first gave 50 deadlocks in 100 transfers; ordered locking gave 0. I also retry up to 3 times
on a deadlock error, which is safe because the aborted transaction wrote nothing.

**7. What is idempotency? How did you implement it?**
Doing something twice has the same effect as once. The client sends a UUID as Idempotency-Key. I
insert it into a table with a UNIQUE index on (user_id, key) inside the same transaction as the
payment. A duplicate key means "already done", so I return the saved response with
`Idempotent-Replayed: true`.

**8. Two identical requests arrive at the exact same millisecond. What happens?**
Both try to insert the same key. InnoDB makes the second insert wait on the unique index until the
first transaction commits; then it gets a duplicate-key error and replays the saved response. My
test fires 20 at once and checks there is exactly one transfer.

**9. Same key but a different amount?**
I store a SHA-256 hash of the route and body. A different hash returns 422 IDEMPOTENCY_KEY_REUSED.

**10. Why save failed responses too?**
If "insufficient funds" were not saved, the user might add money and the old retry would suddenly
succeed — a payment they thought had failed. A key must always give the same answer.

**11. What if the server crashes in the middle?**
The key and the payment are in the same transaction, so both roll back. The key is free and a retry
runs normally. No half-done payments, no stuck keys.

**12. What is double-entry bookkeeping and why use it?**
Every movement writes a debit and an equal credit. Money is never created or lost, only moved. It
gives an audit trail, and I can verify the system: each wallet's balance must equal its credits minus
debits, and the sum of all balances must be zero. `npm run reconcile` checks this.

**13. Why does the sum of all balances equal zero?**
Top-ups come from a SYSTEM wallet that is allowed to go negative. If users added ₹5,000 in total, the
system wallet is at −₹5,000 and users together hold +₹5,000.

**14. Why store money as integers?**
Floats can't represent 0.1 exactly. I store paise in BIGINT and parse amounts from strings without
float maths. "1.999" is rejected.

**15. Why both the cached balance and the ledger?**
Reading a balance by summing thousands of ledger rows is slow. The cached column is fast; the ledger
is the truth. Both are updated in the same transaction, and reconcile proves they match.

**16. What isolation level does MySQL use, and does it matter here?**
InnoDB's default is REPEATABLE READ. A plain SELECT reads a snapshot, which could be stale, so for
the balance I use a locking read (FOR UPDATE), which always reads the latest committed row and locks it.

**17. Which indexes did you add and why?**
`ledger_entries(wallet_id, id)` for history and cursor paging; `transactions(from_wallet_id, type,
created_at)` for the daily-limit sum; `UNIQUE(user_id, idem_key)` for idempotency; `UNIQUE(email)`.

**18. Why cursor pagination instead of OFFSET?**
OFFSET reads and discards rows, so it gets slower deeper in the list, and new payments shift pages.
A cursor (`id < last seen id`) uses the index directly and is stable.

**19. How do you secure the API?**
bcrypt passwords, JWT auth, the same error for wrong email and wrong password, login rate limiting,
parameterized queries, zod validation, users only access their own wallet via the token's user id,
UUID public ids, helmet headers.

**20. How did you test concurrency?**
Against a real MySQL, not mocks. 50 parallel ₹10 transfers from ₹100 → exactly 10 succeed. 60
opposite-direction transfers → all succeed, total unchanged. 150 mixed requests across 5 users → ledger
reconciles. I also removed FOR UPDATE on purpose and confirmed the tests fail.

**21. What's the throughput?**
About 300 transfers per second with 50 concurrent clients on a 2-core container (p95 ~240 ms), 0
errors, ledger consistent afterwards. I have not profiled it yet; my guess is MySQL flushing each commit
to disk and waiting on locks for busy wallets — profiling that would be my next step.

**22. How would you scale it?**
Run more stateless API instances behind a load balancer; tune the connection pool; add read replicas
for history; move the rate limiter to Redis; split the hot SYSTEM wallet; eventually shard wallets by
user id — but then a transfer between shards needs a different design (an outbox / saga).

**23. What would you do differently / next?**
Refunds as reversing ledger entries, a real gateway with signed webhooks, refresh tokens, expiring
idempotency keys with a scheduled job, and Redis-based rate limiting.

**24. What was the hardest bug or decision?**
Where to put the idempotency key. If the key is saved in a separate transaction from the payment,
a crash between them leaves either a paid request with no saved key (retry pays twice) or a key
stuck "in progress". Putting both in one transaction removed that whole class of bugs.

---

## Know these files

| File | What to say |
|---|---|
| `server/src/payments.js` | Locking, double-entry posting, limits, history, reconcile |
| `server/src/idempotency.js` | The run-at-most-once wrapper |
| `server/src/db.js` | Transaction helper and deadlock retry |
| `server/src/money.js` | Rupees ↔ paise with no floats |
| `server/db/schema.sql` | Tables, CHECK constraints, indexes |
| `server/tests/api.test.js` | The concurrency and idempotency tests |
| `server/scripts/race-demo.js` | The before/after numbers |

Run `npm test` and `npm run race-demo` yourself before the interview, so you have seen the output with your own eyes.
