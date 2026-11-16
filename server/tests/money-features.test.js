import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { reconcileAll } from '../src/payments.js';
import { addMoney, api, balanceOf, createUser, newKey, resetDatabase, sendMoney } from './helpers.js';

beforeEach(resetDatabase);
afterAll(() => pool.end());

const refundOf = (user, transactionId, body = {}, key = newKey()) =>
  api().post(`/api/transactions/${transactionId}/refunds`).set(user.auth).set('Idempotency-Key', key).send(body);

const requestMoney = (user, from, amount, note) =>
  api().post('/api/payment-requests').set(user.auth).set('Idempotency-Key', newKey()).send({ fromEmail: from.email, amount, ...(note && { note }) });

const payRequest = (user, id, key = newKey()) => api().post(`/api/payment-requests/${id}/pay`).set(user.auth).set('Idempotency-Key', key).send({});

/** Asha pays Bala ₹100 and returns the transfer id. */
async function paidTransfer() {
  const asha = await createUser('Asha');
  const bala = await createUser('Bala');
  await addMoney(asha, '500');
  const sent = await sendMoney(asha, bala, '100');
  return { asha, bala, transferId: sent.body.transaction.id };
}

describe('refunds', () => {
  it('the recipient refunds in full: money goes back as a new REFUND transaction', async () => {
    const { asha, bala, transferId } = await paidTransfer();
    const res = await refundOf(bala, transferId, { reason: 'Order cancelled' });
    expect(res.status).toBe(201);
    expect(res.body.transaction).toMatchObject({ type: 'REFUND', amountPaise: 10000, refundOf: transferId });
    expect(await balanceOf(asha)).toBe(50000);
    expect(await balanceOf(bala)).toBe(0);
    // The original payment row is untouched; the refund is linked to it.
    const [[original]] = await pool.query('SELECT amount_paise FROM transactions WHERE public_id = ?', [transferId]);
    expect(original.amount_paise).toBe(10000);
    expect((await reconcileAll()).ok).toBe(true);
  });

  it('partial refunds add up to at most the original amount', async () => {
    const { bala, transferId } = await paidTransfer();
    expect((await refundOf(bala, transferId, { amount: '30' })).status).toBe(201);
    expect((await refundOf(bala, transferId, { amount: '70.01' })).body.error.code).toBe('REFUND_TOO_LARGE');
    expect((await refundOf(bala, transferId, { amount: '70' })).status).toBe(201);
    expect((await refundOf(bala, transferId, { amount: '0.01' })).body.error.code).toBe('ALREADY_REFUNDED');
  });

  it('10 simultaneous refunds of ₹20 on a ₹100 payment: exactly 5 succeed', async () => {
    const { bala, transferId } = await paidTransfer();
    const results = await Promise.all(Array.from({ length: 10 }, () => refundOf(bala, transferId, { amount: '20' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const [[{ refunded }]] = await pool.query("SELECT SUM(amount_paise) AS refunded FROM transactions WHERE type = 'REFUND'");
    expect(Number(refunded)).toBe(10000);
    const report = await reconcileAll();
    expect(report.ok).toBe(true);
    expect(report.overRefundedTransactions).toHaveLength(0);
  });

  it('only the recipient can refund, and other people learn nothing about the payment', async () => {
    const { asha, transferId } = await paidTransfer();
    const chitra = await createUser('Chitra');
    for (const someone of [asha, chitra]) {
      const res = await refundOf(someone, transferId);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TRANSACTION_NOT_FOUND');
    }
  });

  it('top-ups cannot be refunded to the platform', async () => {
    const asha = await createUser('Asha');
    const top = await addMoney(asha, '100');
    // A top-up's recipient is the user, but it is not a transfer.
    expect((await refundOf(asha, top.body.transaction.id)).body.error.code).toBe('NOT_REFUNDABLE');
  });

  it('a retried refund (same key) refunds once', async () => {
    const { bala, transferId } = await paidTransfer();
    const key = newKey();
    const [a, b] = await Promise.all([refundOf(bala, transferId, { amount: '40' }, key), refundOf(bala, transferId, { amount: '40' }, key)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']]).toContain('true');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM transactions WHERE type = 'REFUND'");
    expect(n).toBe(1);
  });

  it('activity shows what is still refundable', async () => {
    const { bala, transferId } = await paidTransfer();
    await refundOf(bala, transferId, { amount: '25' });
    const items = (await api().get('/api/wallet/activity').set(bala.auth)).body.items;
    const received = items.find((i) => i.id === transferId);
    expect(received).toMatchObject({ refundedPaise: 2500, refundablePaise: 7500 });
    expect(items[0]).toMatchObject({ type: 'REFUND', direction: 'DEBIT', refundOf: transferId });
  });
});

describe('payment requests', () => {
  it('request -> pay: money moves and the request is marked paid', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(bala, '500');
    const req = await requestMoney(asha, bala, '120.50', 'Dinner');
    expect(req.status).toBe(201);
    expect(req.body.request).toMatchObject({ status: 'PENDING', amountPaise: 12050 });

    const incoming = await api().get('/api/payment-requests?direction=incoming').set(bala.auth);
    expect(incoming.body.items[0]).toMatchObject({ id: req.body.request.id, counterparty: { email: asha.email } });

    const paid = await payRequest(bala, req.body.request.id);
    expect(paid.status).toBe(201);
    expect(paid.body.request.status).toBe('PAID');
    expect(await balanceOf(asha)).toBe(12050);
    const outgoing = await api().get('/api/payment-requests?direction=outgoing&status=PAID').set(asha.auth);
    expect(outgoing.body.items).toHaveLength(1);
  });

  it('two simultaneous "pay" clicks with different keys pay once', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(bala, '500');
    const { id } = (await requestMoney(asha, bala, '100')).body.request;
    const results = await Promise.all([payRequest(bala, id), payRequest(bala, id), payRequest(bala, id)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'REQUEST_CLOSED')).toBe(true);
    expect(await balanceOf(asha)).toBe(10000);
  });

  it('pay and cancel at the same moment: exactly one of them wins', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(bala, '500');
    const { id } = (await requestMoney(asha, bala, '100')).body.request;
    const [pay, cancel] = await Promise.all([payRequest(bala, id), api().post(`/api/payment-requests/${id}/cancel`).set(asha.auth)]);
    const wins = [pay.status === 201, cancel.status === 200].filter(Boolean);
    expect(wins).toHaveLength(1);
    const [[row]] = await pool.query('SELECT status FROM payment_requests WHERE public_id = ?', [id]);
    expect(row.status).toBe(pay.status === 201 ? 'PAID' : 'CANCELLED');
    expect(await balanceOf(asha)).toBe(pay.status === 201 ? 10000 : 0);
  });

  it('only the payer can pay or decline; only the requester can cancel', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const { id } = (await requestMoney(asha, bala, '10')).body.request;
    expect((await payRequest(asha, id)).status).toBe(404);
    expect((await api().post(`/api/payment-requests/${id}/decline`).set(asha.auth)).status).toBe(404);
    expect((await api().post(`/api/payment-requests/${id}/cancel`).set(bala.auth)).status).toBe(404);
    expect((await api().post(`/api/payment-requests/${id}/decline`).set(bala.auth)).body.request.status).toBe('DECLINED');
    expect((await payRequest(bala, id)).body.error.code).toBe('REQUEST_CLOSED');
  });

  it('paying a request follows transfer rules (insufficient funds leaves it pending)', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const { id } = (await requestMoney(asha, bala, '10')).body.request;
    expect((await payRequest(bala, id)).body.error.code).toBe('INSUFFICIENT_FUNDS');
    const [[row]] = await pool.query('SELECT status FROM payment_requests WHERE public_id = ?', [id]);
    expect(row.status).toBe('PENDING');
  });

  it('rejects requesting from yourself and caps open requests', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    expect((await requestMoney(asha, asha, '1')).body.error.code).toBe('SELF_REQUEST');
    for (let i = 0; i < 20; i++) expect((await requestMoney(asha, bala, '1')).status).toBe(201);
    expect((await requestMoney(asha, bala, '1')).body.error.code).toBe('TOO_MANY_OPEN_REQUESTS');
  });
});

describe('statements', () => {
  const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

  it('CSV has opening and closing balances and protects against spreadsheet formulas', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '1000');
    await sendMoney(asha, bala, '250.50', newKey(), '=HYPERLINK("http://evil")');
    const res = await api().get(`/api/wallet/statement?from=${today()}&to=${today()}&format=csv`).set(asha.auth);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="payledger-statement-/);
    const lines = res.text.trim().split('\r\n');
    expect(lines[1]).toBe(',Opening balance,,,,,0.00');
    expect(res.text).toContain(`"'=HYPERLINK(""http://evil"")"`); // neutralised, not a formula
    expect(lines.at(-1)).toBe(',Closing balance,,,250.50,1000.00,749.50');
  });

  it('JSON totals match, and the PDF is a real PDF', async () => {
    const asha = await createUser('Asha');
    await addMoney(asha, '300');
    const json = await api().get(`/api/wallet/statement?from=${today()}&to=${today()}&format=json`).set(asha.auth);
    expect(json.body).toMatchObject({ openingPaise: 0, closingPaise: 30000, totalInPaise: 30000, totalOutPaise: 0 });
    const pdf = await api()
      .get(`/api/wallet/statement?from=${today()}&to=${today()}&format=pdf`)
      .set(asha.auth)
      .buffer(true)
      .parse((res, done) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('validates the date range', async () => {
    const asha = await createUser('Asha');
    expect((await api().get('/api/wallet/statement?from=2026-02-01&to=2026-01-01').set(asha.auth)).body.error.code).toBe('INVALID_RANGE');
    expect((await api().get('/api/wallet/statement?from=2024-01-01&to=2026-01-01').set(asha.auth)).body.error.code).toBe('RANGE_TOO_LONG');
    expect((await api().get('/api/wallet/statement?from=yesterday&to=today').set(asha.auth)).status).toBe(400);
  });
});

describe('wallet status and currency', () => {
  it('a frozen wallet can neither send nor receive', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '100');
    await pool.query("UPDATE wallets w JOIN users u ON u.id = w.user_id SET w.status = 'FROZEN' WHERE u.email = ?", [bala.email]);
    expect((await sendMoney(asha, bala, '10')).body.error.code).toBe('WALLET_FROZEN');
    expect((await sendMoney(bala, asha, '10')).body.error.code).toBe('WALLET_FROZEN');
    expect((await addMoney(bala, '10')).body.error.code).toBe('WALLET_FROZEN');
  });

  it('refuses to move money between wallets in different currencies', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '100');
    await pool.query("UPDATE wallets w JOIN users u ON u.id = w.user_id SET w.currency = 'USD' WHERE u.email = ?", [bala.email]);
    expect((await sendMoney(asha, bala, '10')).body.error.code).toBe('CURRENCY_MISMATCH');
  });
});
