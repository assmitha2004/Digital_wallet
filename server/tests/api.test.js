import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { reconcileAll } from '../src/payments.js';
import { addMoney, api, balanceOf, createUser, newKey, resetDatabase, sendMoney } from './helpers.js';

beforeEach(resetDatabase);
afterAll(() => pool.end());

describe('auth', () => {
  it('registers a user with an empty wallet', async () => {
    const asha = await createUser('Asha');
    const me = await api().get('/api/me').set(asha.auth);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('asha@test.dev');
    expect(me.body.wallet).toEqual({ balancePaise: 0, balance: '0.00', currency: 'INR' });
  });

  it('rejects a duplicate email with 409', async () => {
    await createUser('Asha');
    const res = await api().post('/api/auth/register').send({ name: 'Asha 2', email: 'ASHA@test.dev', password: 'password123' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('logs in, and gives the same error for a wrong password and an unknown email', async () => {
    await createUser('Asha');
    const ok = await api().post('/api/auth/login').send({ email: 'asha@test.dev', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();

    const wrongPassword = await api().post('/api/auth/login').send({ email: 'asha@test.dev', password: 'nope-nope' });
    const unknownEmail = await api().post('/api/auth/login').send({ email: 'ghost@test.dev', password: 'nope-nope' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('blocks requests without a valid token', async () => {
    expect((await api().get('/api/me')).status).toBe(401);
    expect((await api().get('/api/me').set('Authorization', 'Bearer forged.token.value')).status).toBe(401);
  });

  it('never stores the plain password', async () => {
    await createUser('Asha');
    const [[row]] = await pool.query('SELECT password_hash FROM users');
    expect(row.password_hash).not.toContain('password123');
    expect(row.password_hash).toMatch(/^\$2[aby]\$/);
  });
});

describe('top-ups and transfers', () => {
  it('adds money and writes a balanced double entry', async () => {
    const asha = await createUser('Asha');
    const res = await addMoney(asha, '500.00');
    expect(res.status).toBe(201);
    expect(res.body.balancePaise).toBe(50000);

    const [entries] = await pool.query('SELECT wallet_id, direction, amount_paise FROM ledger_entries ORDER BY id');
    expect(entries).toEqual([
      { wallet_id: 1, direction: 'DEBIT', amount_paise: 50000 },
      { wallet_id: 2, direction: 'CREDIT', amount_paise: 50000 },
    ]);
    expect((await reconcileAll()).ok).toBe(true);
  });

  it('sends money by email and updates both balances', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '500');

    const res = await sendMoney(asha, bala, '120.50', newKey(), 'lunch');
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ type: 'TRANSFER', amountPaise: 12050, to: { email: 'bala@test.dev' }, note: 'lunch' });
    expect(await balanceOf(asha)).toBe(37950);
    expect(await balanceOf(bala)).toBe(12050);
    expect((await reconcileAll()).ok).toBe(true);
  });

  it('rejects overdrafts, self-transfers, unknown recipients and bad amounts', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '100');

    const overdraft = await sendMoney(asha, bala, '100.01');
    expect(overdraft.status).toBe(422);
    expect(overdraft.body.error.code).toBe('INSUFFICIENT_FUNDS');

    expect((await sendMoney(asha, asha, '1')).body.error.code).toBe('SELF_TRANSFER');
    expect((await sendMoney(asha, { email: 'ghost@test.dev' }, '1')).status).toBe(404);
    expect((await sendMoney(asha, bala, '1.999')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await sendMoney(asha, bala, '-5')).body.error.code).toBe('VALIDATION_FAILED');

    expect(await balanceOf(asha)).toBe(10000);
    const [[{ count }]] = await pool.query("SELECT COUNT(*) AS count FROM transactions WHERE type = 'TRANSFER'");
    expect(count).toBe(0);
  });

  it('enforces per-payment and daily limits', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    expect((await addMoney(asha, '50000.01')).body.error.code).toBe('LIMIT_EXCEEDED');

    for (let i = 0; i < 5; i++) expect((await addMoney(asha, '50000')).status).toBe(201); // ₹2,50,000
    expect((await sendMoney(asha, bala, '100000.01')).body.error.code).toBe('LIMIT_EXCEEDED');
    expect((await sendMoney(asha, bala, '100000')).status).toBe(201);
    expect((await sendMoney(asha, bala, '100000')).status).toBe(201);
    const third = await sendMoney(asha, bala, '0.01');
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('DAILY_LIMIT_EXCEEDED');
  });

  it('requires an Idempotency-Key on payments', async () => {
    const asha = await createUser('Asha');
    const res = await api().post('/api/wallet/topups').set(asha.auth).send({ amount: '10' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('idempotency', () => {
  it('a retried transfer with the same key moves money once and returns the same response', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '500');
    const key = newKey();

    const first = await sendMoney(asha, bala, '100', key);
    const retry = await sendMoney(asha, bala, '100', key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.transaction.id).toBe(first.body.transaction.id);
    expect(await balanceOf(bala)).toBe(10000);
  });

  it('replays a failed result too, so a retry cannot succeed later by accident', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const key = newKey();
    expect((await sendMoney(asha, bala, '50', key)).body.error.code).toBe('INSUFFICIENT_FUNDS');
    await addMoney(asha, '500');
    const retry = await sendMoney(asha, bala, '50', key);
    expect(retry.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(await balanceOf(bala)).toBe(0);
  });

  it('rejects the same key with a different body', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '500');
    const key = newKey();
    await sendMoney(asha, bala, '100', key);
    const misuse = await sendMoney(asha, bala, '200', key);
    expect(misuse.status).toBe(422);
    expect(misuse.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keys belong to one user: two users may use the same key', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    expect((await addMoney(asha, '10', 'shared-key-123')).status).toBe(201);
    const balaRes = await addMoney(bala, '10', 'shared-key-123');
    expect(balaRes.status).toBe(201);
    expect(balaRes.headers['idempotent-replayed']).toBeUndefined();
  });

  it('20 simultaneous requests with the same key produce exactly one transfer', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '500');
    const key = newKey();

    const responses = await Promise.all(Array.from({ length: 20 }, () => sendMoney(asha, bala, '100', key)));
    expect(responses.every((res) => res.status === 201)).toBe(true);
    expect(new Set(responses.map((res) => res.body.transaction.id)).size).toBe(1);
    expect(responses.filter((res) => res.headers['idempotent-replayed'] === 'true')).toHaveLength(19);
    expect(await balanceOf(bala)).toBe(10000);
  });
});

describe('concurrency', () => {
  it('50 simultaneous ₹10 transfers from a ₹100 wallet: exactly 10 succeed, balance never goes negative', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '100');

    const responses = await Promise.all(Array.from({ length: 50 }, () => sendMoney(asha, bala, '10')));
    const succeeded = responses.filter((res) => res.status === 201);
    const rejected = responses.filter((res) => res.body.error?.code === 'INSUFFICIENT_FUNDS');

    expect(succeeded).toHaveLength(10);
    expect(rejected).toHaveLength(40);
    expect(await balanceOf(asha)).toBe(0);
    expect(await balanceOf(bala)).toBe(10000);
    expect(await reconcileAll()).toMatchObject({ ok: true, totalOfAllBalancesPaise: 0 });
  });

  it('opposite-direction transfers (A->B and B->A at the same time) all complete without deadlock', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '1000');
    await addMoney(bala, '1000');

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? sendMoney(asha, bala, '1') : sendMoney(bala, asha, '1'))),
    );
    expect(responses.every((res) => res.status === 201)).toBe(true);
    expect((await balanceOf(asha)) + (await balanceOf(bala))).toBe(200000);
    expect((await reconcileAll()).ok).toBe(true);
  });

  it('a mixed load across 5 users keeps the ledger consistent', async () => {
    const users = await Promise.all(['A1', 'B2', 'C3', 'D4', 'E5'].map(createUser));
    await Promise.all(users.map((user) => addMoney(user, '200')));

    const requests = Array.from({ length: 150 }, (_, i) => {
      const from = users[i % 5];
      const to = users[(i * 3 + 1) % 5];
      return from === to ? addMoney(from, '1') : sendMoney(from, to, String(1 + (i % 7)));
    });
    const responses = await Promise.all(requests);
    expect(responses.every((res) => [201, 422].includes(res.status))).toBe(true);

    const report = await reconcileAll();
    expect(report).toMatchObject({ ok: true, negativeUserWallets: 0, totalOfAllBalancesPaise: 0 });
  });
});

describe('activity history', () => {
  it('pages newest-first with a cursor and shows the other party', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '100');
    for (let i = 1; i <= 5; i++) await sendMoney(asha, bala, String(i));

    const page1 = await api().get('/api/wallet/activity?limit=4').set(asha.auth);
    expect(page1.body.items.map((item) => item.amount)).toEqual(['5.00', '4.00', '3.00', '2.00']);
    expect(page1.body.items[0]).toMatchObject({ direction: 'DEBIT', counterparty: { email: 'bala@test.dev' } });

    const page2 = await api().get(`/api/wallet/activity?limit=4&cursor=${page1.body.nextCursor}`).set(asha.auth);
    expect(page2.body.items.map((item) => item.amount)).toEqual(['1.00', '100.00']);
    expect(page2.body.items[1]).toMatchObject({ type: 'TOPUP', counterparty: null });
    expect(page2.body.nextCursor).toBeNull();
  });

  it('only shows the logged-in user their own activity', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '50');
    const balaView = await api().get('/api/wallet/activity').set(bala.auth);
    expect(balaView.body.items).toEqual([]);
  });

  it('verify endpoint confirms balance equals the ledger sum', async () => {
    const asha = await createUser('Asha');
    await addMoney(asha, '75.25');
    const res = await api().get('/api/wallet/verify').set(asha.auth);
    expect(res.body).toEqual({ balancePaise: 7525, ledgerPaise: 7525, entries: 1, matches: true });
  });
});

describe('database safety net', () => {
  it('the CHECK constraint rejects a negative user balance even if app code were wrong', async () => {
    await createUser('Asha');
    await expect(pool.query('UPDATE wallets SET balance_paise = -1 WHERE id = 2')).rejects.toThrow(/chk_wallet_non_negative/);
  });
});
