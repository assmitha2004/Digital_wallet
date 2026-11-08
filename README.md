# PayLedger — Digital Wallet & Payments

A full-stack digital wallet: users add money, send it to each other by email, and see their history.
The interesting part is under the hood — a **double-entry ledger**, **row-level locking** and
**idempotent payments**, so money is never double-spent, duplicated or lost, even when many requests
arrive at the same moment or a client retries after a timeout.

![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

**Live demo:** _add your Vercel link here_ · demo login `demo@payledger.dev` / `demo12345`

<img src="docs/screenshots/dashboard.png" alt="PayLedger dashboard" width="860">

**43 automated tests** · **0 double-spends in 50 simultaneous requests** · **0 deadlocks with ordered locking** · **~300 transfers/s with the ledger still balanced**

---

## What it does

| Feature | Details |
|---|---|
| Accounts | Register / log in, bcrypt password hashing, JWT auth, login rate limiting |
| Wallet | One wallet per user, balance in ₹ stored as integer **paise** |
| Add money | Simulated payment gateway, up to ₹50,000 per top-up |
| Send money | To any user by email, with an optional note; ₹1,00,000 per transfer, ₹2,00,000 per day |
| History | Newest-first activity with running balance, **cursor pagination** |
| Audit | `GET /api/wallet/verify` and `npm run reconcile` prove every balance equals its ledger |

## How money stays correct

| Problem | What could go wrong | How PayLedger prevents it |
|---|---|---|
| **Double-spending** | Two ₹60 transfers from a ₹100 wallet both see "₹100" and both go through | `SELECT … FOR UPDATE` locks the wallet row; the balance check runs *after* the lock |
| **Deadlocks** | A→B and B→A at the same time each hold one lock and wait for the other forever | Wallets are always locked in **ascending id order**, plus a small retry for any deadlock InnoDB still reports |
| **Duplicate payments** | The network drops the response, the app retries, the user pays twice | `Idempotency-Key` header + a **UNIQUE index**: the same key runs once, retries get the saved response |
| **Lost money** | A bug updates one balance but not the other | **Double-entry ledger**: every payment writes one DEBIT and one CREDIT in the same DB transaction |
| **Rounding errors** | `0.1 + 0.2 = 0.30000000000000004` | Money is integer **paise** (`BIGINT`), parsed from strings — never floats |
| **App bugs** | Some future code path overdraws a wallet | MySQL `CHECK (balance_paise >= 0)` rejects it at the database |

### Proof: `npm run race-demo`

Real output against MySQL 8 (it runs in CI too):

```
Experiment 1: 50 simultaneous ₹10 transfers from a ₹100 wallet
│ method                       │ transfers accepted (correct: 10) │ sender left (₹) │ receiver got (₹) │ money created out of nothing (₹) │
│ read, check, write (no lock) │ 50                               │ 40              │ 500              │ 440                              │
│ SELECT ... FOR UPDATE        │ 10                               │ 0               │ 100              │ 0                                │

Experiment 2: 100 simultaneous transfers, half A->B and half B->A
│ method              │ deadlocks out of 100 transfers │
│ lock sender first   │ 50                             │
│ lock lower id first │ 0                              │
```

### Load test: `npm run benchmark`

2,000 random transfers between 50 users, 50 concurrent clients, single Node process + MySQL on a
2-core dev container (your numbers will differ):

| Throughput | p50 | p95 | p99 | Errors | Ledger consistent after |
|---|---|---|---|---|---|
| ~300 transfers/s | ~150 ms | ~240 ms | ~285 ms | 0 | yes |

## Architecture

```
React (Vite)  ──fetch /api──►  Express API  ──mysql2 pool──►  MySQL 8 (InnoDB)
                                 │
                                 ├─ auth.js         register / login, JWT
                                 ├─ walletRoutes.js validation (zod), routes
                                 ├─ idempotency.js  run-at-most-once wrapper
                                 └─ payments.js     locking + double-entry posting + audit
```

A transfer, step by step (one database transaction):

```
BEGIN
  INSERT idempotency key            -- duplicate? replay saved response and stop
  look up recipient by email
  SELECT wallet (lower id) FOR UPDATE
  SELECT wallet (higher id) FOR UPDATE
  check balance, per-transfer limit, daily limit   -- all checks happen while holding the locks
  UPDATE sender   balance - amount
  UPDATE receiver balance + amount
  INSERT transaction  + 2 ledger entries (DEBIT, CREDIT)
  save response on the idempotency key
COMMIT
```

More detail, in plain English: [`docs/DESIGN.md`](docs/DESIGN.md).

## API

All endpoints except `/api/auth/*` need `Authorization: Bearer <token>`.
Payments need an `Idempotency-Key` header (8–64 characters). Errors look like `{"error": {"code", "message"}}`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | `{name, email, password}` → token |
| POST | `/api/auth/login` | `{email, password}` → token (rate limited) |
| GET | `/api/me` | Profile and balance |
| POST | `/api/wallet/topups` | `{amount: "500.00"}` — add money |
| POST | `/api/transfers` | `{toEmail, amount: "250.50", note?}` — send money |
| GET | `/api/wallet/activity?limit=20&cursor=…` | History, newest first |
| GET | `/api/wallet/verify` | Balance vs ledger sum for your wallet |
| GET | `/api/health` | Health check |

```bash
curl -X POST localhost:4000/api/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 3f1c9a7e-pay-rent" \
  -H "Content-Type: application/json" \
  -d '{"toEmail":"meera@payledger.dev","amount":"120.50","note":"Dinner split"}'
```

Send the same request again and you get the same response with `Idempotent-Replayed: true`, and no second payment.

| Code | Status | Meaning |
|---|---|---|
| `INSUFFICIENT_FUNDS` | 422 | Balance too low |
| `LIMIT_EXCEEDED` / `DAILY_LIMIT_EXCEEDED` | 422 | Over a payment limit |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different request body |
| `RECIPIENT_NOT_FOUND` | 404 | No user with that email |
| `VALIDATION_FAILED` | 400 | Bad input (e.g. `"1.999"`) |

## Data model

```
users ──1:1── wallets ──1:N── ledger_entries ──N:1── transactions
  └──1:N── idempotency_keys
```

- `wallets.balance_paise` is a cached total; `ledger_entries` is the source of truth.
- `transactions.public_id` is a UUID — internal auto-increment ids are never exposed.
- Indexes: `ledger_entries(wallet_id, id)` for history paging, `transactions(from_wallet_id, type, created_at)` for the daily limit, `UNIQUE(user_id, idem_key)` for idempotency.

Full schema: [`server/db/schema.sql`](server/db/schema.sql).

## Run it locally

Needs Node 20+ and MySQL 8.

```bash
cp .env.example .env            # set DATABASE_URL and JWT_SECRET
npm install && npm --prefix web install
npm run migrate                 # create tables
npm run seed                    # optional demo data
npm run dev                     # API on http://localhost:4000
npm run web:dev                 # React app on http://localhost:5173
```

Or everything with Docker: `docker compose up --build`, then open http://localhost:4000.

## Tests

```bash
npm test             # 43 tests: money parsing, auth, payments, idempotency, concurrency, history
npm run race-demo    # why the locks exist, with numbers
npm run benchmark    # load test (wipes its database — point DATABASE_URL at a scratch DB)
npm run reconcile    # audits the whole ledger, exits 1 on any mismatch
```

Tests run against a **real MySQL**, because locking behaviour cannot be tested with mocks.
Highlights:

- 50 simultaneous ₹10 transfers from a ₹100 wallet → exactly 10 succeed, final balance ₹0.
- 60 opposite-direction transfers at once → all succeed, total money unchanged.
- 20 simultaneous requests with the same idempotency key → exactly one transfer.
- A failed payment (insufficient funds) is also replayed, so a later retry cannot succeed by surprise.
- Removing `FOR UPDATE` makes the concurrency tests fail (checked by hand).

CI (GitHub Actions) runs the tests, the race demo and the frontend build against MySQL on every push.

## Deploy to Vercel

The live demo runs on **Vercel** (Singapore, `sin1`) with a free **TiDB Cloud Starter** database
(MySQL-compatible, also in Singapore so each query is a short hop).

1. Create a free MySQL-compatible database: TiDB Cloud → Create → **Starter** (or any MySQL 8 host such as Aiven).
2. On Vercel: **Add New → Project**, import this repo, keep the root directory.
3. Add environment variables:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | `mysql://USER:PASSWORD@HOST:4000/payledger` |
   | `JWT_SECRET` | a long random string (`openssl rand -base64 48`) |
   | `DB_SSL` | `true` |
   | `DB_CA_CERT` | only if your provider uses its own certificate authority (Aiven does, TiDB does not) |

4. Deploy. The build runs `npm run migrate` (creates the database and tables), `npm run seed`
   (demo account, safe to repeat) and builds the React app. `/api/*` runs as a serverless function.

**MySQL vs TiDB.** Tests and benchmarks run on MySQL 8. The same code runs on TiDB: the schema adds
`AUTO_ID_CACHE=1` inside TiDB-only comments so ids stay in insert order (needed for cursor paging),
and idempotency replays use `FOR UPDATE` because TiDB does not support `FOR SHARE`.

## Project layout

```
api/index.js            Vercel entry → Express app
server/src/             app.js, auth.js, walletRoutes.js, payments.js, idempotency.js, db.js, money.js
server/db/schema.sql    tables, constraints, indexes
server/scripts/         migrate, seed, reconcile, race-demo, benchmark
server/tests/           Vitest + Supertest
web/src/                React app (App.jsx, api.js, styles.css)
docs/                   DESIGN.md, INTERVIEW_PREP.md, screenshots
```

## What I would add next

- Transaction **reversals/refunds** as new ledger entries (never edits to old ones).
- A real payment gateway (Razorpay) with signed **webhooks** for top-ups.
- Refresh tokens and 2-step verification for large transfers.
- A shared rate limiter (Redis) — the current one is per process.
- Expire idempotency keys after 24 hours with a scheduled cleanup job.
