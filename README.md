# PayLedger

**A full-stack digital wallet where money stays correct under concurrent requests and client retries.**

Users add money, send it to each other by email and see their history. Underneath, every payment is a
double-entry ledger write, wallet rows are locked in a fixed order, and every payment request is idempotent.
So money is never double-spent, duplicated or lost.

![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-2088FF?logo=githubactions&logoColor=white)

**Live demo:** [digital-wallet-coral-theta.vercel.app](https://digital-wallet-coral-theta.vercel.app) — log in with `demo@payledger.dev` / `demo12345`

<img src="docs/screenshots/dashboard.png" alt="PayLedger dashboard" width="860">

| 43 automated tests | 0 double-spends | 0 deadlocks | ~300 transfers/s |
|:---:|:---:|:---:|:---:|
| run against real MySQL in CI | 50 simultaneous transfers | with ordered locking | ledger still balanced |

---

## The problem, in one experiment

A wallet holds ₹100. Fifty requests to send ₹10 arrive at the same moment. Exactly 10 should succeed.

`npm run race-demo` runs this against MySQL 8 (it also runs in CI):

| Method | Transfers accepted (correct: 10) | Money created from nothing |
|---|:---:|:---:|
| Read balance, check, write (no lock) | **50** | **₹440** |
| `SELECT … FOR UPDATE` (this project) | **10** | **₹0** |

| Method (100 transfers, half A→B, half B→A) | Deadlocks |
|---|:---:|
| Lock the sender's wallet first | 50 |
| Lock the lower wallet id first (this project) | **0** |

---

## How money stays correct

| Risk | What could go wrong | How PayLedger prevents it |
|---|---|---|
| **Double-spending** | Two ₹60 transfers from a ₹100 wallet both see ₹100 and both succeed | `SELECT … FOR UPDATE` locks the wallet row; the balance check runs only after the lock is held |
| **Deadlocks** | A→B and B→A each hold one lock and wait for the other | Wallets are always locked in ascending id order; a rare InnoDB deadlock is retried (safe, because the aborted transaction wrote nothing) |
| **Duplicate payments** | The response is lost, the app retries, the user pays twice | `Idempotency-Key` header + `UNIQUE(user_id, idem_key)`: the same key runs once, and retries get the saved response |
| **Key reuse** | The same key is sent with a different amount | The request body is hashed (SHA-256); a mismatch returns `422 IDEMPOTENCY_KEY_REUSED` |
| **Lost money** | A bug updates one balance but not the other | Double-entry ledger: one DEBIT and one CREDIT in the same transaction; `npm run reconcile` audits the whole ledger |
| **Rounding errors** | `0.1 + 0.2 = 0.30000000000000004` | Money is integer paise (`BIGINT`), parsed from strings, never floats |
| **Future bugs** | New code overdraws a wallet | MySQL `CHECK (balance_paise >= 0)` rejects it at the database |

### One transfer, step by step (a single DB transaction)

```
BEGIN
  INSERT idempotency key                 -- already used? replay the saved response and stop
  find recipient by email
  SELECT wallet (lower id)  FOR UPDATE
  SELECT wallet (higher id) FOR UPDATE
  check balance, per-transfer limit, daily limit     -- all while holding the locks
  UPDATE sender   balance - amount
  UPDATE receiver balance + amount
  INSERT transaction + 2 ledger entries (DEBIT, CREDIT)
  save the response on the idempotency key
COMMIT
```

A full explanation of each design choice is in [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Features

- Register and log in (bcrypt password hashing, JWT, login rate limiting)
- Add money through a simulated payment gateway (up to ₹50,000 per top-up)
- Send money by email with an optional note (₹1,00,000 per transfer, ₹2,00,000 per day, day measured in IST)
- Activity history, newest first, with running balance and cursor pagination
- `GET /api/wallet/verify` shows that your balance equals the sum of your ledger entries

## Architecture

```mermaid
flowchart LR
  UI["React (Vite)"] -->|"REST /api + JWT"| API
  subgraph API["Express API"]
    AUTH["auth.js<br/>register, login"]
    ROUTES["walletRoutes.js<br/>Zod validation"]
    IDEM["idempotency.js<br/>run at most once"]
    PAY["payments.js<br/>locks + double entry"]
    ROUTES --> IDEM --> PAY
  end
  API -->|"mysql2 pool"| DB[("MySQL 8 / InnoDB")]
```

```
users ──1:1── wallets ──1:N── ledger_entries ──N:1── transactions
  └──1:N── idempotency_keys
```

- `wallets.balance_paise` is a cached total; `ledger_entries` is the source of truth.
- Clients see UUIDs (`transactions.public_id`); internal auto-increment ids are never exposed.
- Indexes: `ledger_entries(wallet_id, id)` for history paging, `transactions(from_wallet_id, type, created_at)`
  for the daily limit, `UNIQUE(user_id, idem_key)` for idempotency.

Full schema: [`server/db/schema.sql`](server/db/schema.sql)

## API

All endpoints except `/api/auth/*` need `Authorization: Bearer <token>`. Payments also need an
`Idempotency-Key` header (8–64 characters). Errors have one shape: `{"error": {"code", "message"}}`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register` | `{name, email, password}` → token |
| POST | `/api/auth/login` | `{email, password}` → token (rate limited) |
| GET | `/api/me` | Profile and balance |
| POST | `/api/wallet/topups` | `{amount: "500.00"}` |
| POST | `/api/transfers` | `{toEmail, amount: "250.50", note?}` |
| GET | `/api/wallet/activity?limit=20&cursor=…` | History, newest first |
| GET | `/api/wallet/verify` | Balance vs ledger sum |
| GET | `/api/health` | Health check |

```bash
curl -X POST localhost:4000/api/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: 3f1c9a7e-pay-rent" \
  -H "Content-Type: application/json" \
  -d '{"toEmail":"meera@payledger.dev","amount":"120.50","note":"Dinner split"}'
```

Sending the same request again returns the same response with `Idempotent-Replayed: true`, and no second payment.

| Code | Status | Meaning |
|---|:---:|---|
| `INSUFFICIENT_FUNDS` | 422 | Balance too low |
| `LIMIT_EXCEEDED`, `DAILY_LIMIT_EXCEEDED` | 422 | Over a payment limit |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Same key, different request |
| `RECIPIENT_NOT_FOUND` | 404 | No user with that email |
| `VALIDATION_FAILED` | 400 | Bad input, e.g. `"1.999"` |

## Testing

Tests run against a **real MySQL database**, because locking behaviour cannot be tested with mocks.

```bash
npm test             # 43 tests: money parsing, auth, payments, idempotency, concurrency, history
npm run race-demo    # the experiment above
npm run benchmark    # load test (wipes its database: use a scratch DB)
npm run reconcile    # audits the whole ledger; exits 1 on any mismatch
```

What the tests prove:

- 50 simultaneous ₹10 transfers from a ₹100 wallet → exactly 10 succeed, and the balance never goes negative.
- Opposite-direction transfers at the same time all finish without deadlock, and total money is unchanged.
- 20 simultaneous requests with the same idempotency key → exactly one transfer.
- A failed payment is replayed too, so a later retry cannot succeed by surprise.
- The `CHECK` constraint rejects a negative balance even if application code were wrong.

**CI** (GitHub Actions, on every push and pull request): tests against a MySQL 8.4 service container,
the race demo and the frontend build.

### Load test

2,000 random transfers between 50 users, 50 concurrent clients, one Node process + MySQL on a
2-core dev container. Your numbers will differ.

| Throughput | p50 | p95 | p99 | Errors | Ledger balanced after |
|:---:|:---:|:---:|:---:|:---:|:---:|
| ~300 transfers/s | ~150 ms | ~240 ms | ~285 ms | 0 | yes |

## Run it locally

Needs Node 20+ and MySQL 8.

```bash
cp .env.example .env              # set DATABASE_URL and JWT_SECRET
npm install && npm --prefix web install
npm run migrate                   # create tables
npm run seed                      # optional demo data
npm run dev                       # API on http://localhost:4000
npm run web:dev                   # React app on http://localhost:5173
```

Or run everything with Docker: `docker compose up --build`, then open http://localhost:4000.

## Deployment

The live demo runs on **Vercel** (Singapore) with a **TiDB Cloud** database (MySQL-compatible). `/api/*` runs as
a serverless function. The build runs the migration and the seed (safe to repeat), then builds the React app.

| Variable | Value |
|---|---|
| `DATABASE_URL` | `mysql://USER:PASSWORD@HOST:4000/payledger` |
| `JWT_SECRET` | a long random string (`openssl rand -base64 48`) |
| `DB_SSL` | `true` |
| `DB_CA_CERT` | only if your provider uses its own certificate authority |

Tests and benchmarks run on MySQL 8. The same code runs on TiDB: the schema adds `AUTO_ID_CACHE=1` in TiDB-only
comments so ids stay in insert order (needed for cursor paging), and idempotency replays use `FOR UPDATE`
because TiDB does not support `FOR SHARE`.

## Project layout

```
api/index.js           Vercel entry → Express app
server/src/            app, auth, walletRoutes, payments, idempotency, db, money
server/db/schema.sql   tables, constraints, indexes
server/scripts/        migrate, seed, reconcile, race-demo, benchmark
server/tests/          Vitest + Supertest
web/src/               React app
docs/                  DESIGN.md, screenshots
```

## Next steps

- Refunds and reversals as new ledger entries (never edits to old ones)
- A real payment gateway (Razorpay) with signed webhooks for top-ups
- Refresh tokens, and a second verification step for large transfers
- A shared rate limiter in Redis (the current one is per process)
- Expire idempotency keys after 24 hours with a scheduled job

---

Built by [Asmitha A G](https://github.com/assmitha2004) · [LinkedIn](https://linkedin.com/in/asmitha-a-g)
