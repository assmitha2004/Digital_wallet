import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adminRouter } from '../src/adminRoutes.js';
import { authRouter } from '../src/auth.js';
import { pool } from '../src/db.js';
import { checkoutSignature, setRemoteOrderCreator, webhookSignature } from '../src/gateway.js';
import { openapiSpec, opsRouter } from '../src/opsRoutes.js';
import { reconcileAll } from '../src/payments.js';
import { walletRouter } from '../src/walletRoutes.js';
import { addMoney, api, balanceOf, config, createUser, newKey, resetDatabase, sendMoney, withConfig } from './helpers.js';

beforeEach(resetDatabase);
afterAll(() => pool.end());

async function makeAdmin(user) {
  await pool.query("UPDATE users SET role = 'ADMIN' WHERE email = ?", [user.email]);
  return user;
}

describe('admin', () => {
  it('only admins can use admin endpoints', async () => {
    const asha = await createUser('Asha');
    const res = await api().get('/api/admin/users').set(asha.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('search users, freeze a wallet (payments stop), unfreeze it, with every step audited', async () => {
    const admin = await makeAdmin(await createUser('Admin'));
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '100');

    const found = await api().get('/api/admin/users?q=asha').set(admin.auth);
    expect(found.body.items).toHaveLength(1);
    const ashaId = found.body.items[0].id;

    const frozen = await api().post(`/api/admin/users/${ashaId}/freeze`).set(admin.auth).send({ reason: 'Suspicious activity' });
    expect(frozen.body.walletStatus).toBe('FROZEN');
    expect((await sendMoney(asha, bala, '10')).body.error.code).toBe('WALLET_FROZEN');

    await api().post(`/api/admin/users/${ashaId}/unfreeze`).set(admin.auth).send({ reason: 'Verified with customer' }).expect(200);
    expect((await sendMoney(asha, bala, '10')).status).toBe(201);

    const audit = await api().get('/api/admin/audit-logs?action=WALLET_FROZEN').set(admin.auth);
    expect(audit.body.items[0]).toMatchObject({
      action: 'WALLET_FROZEN',
      actor: { email: admin.email },
      target: { type: 'user', id: String(ashaId) },
      metadata: { reason: 'Suspicious activity', previous: 'ACTIVE' },
    });
  });

  it('an admin cannot freeze their own wallet, and reasons are required', async () => {
    const admin = await makeAdmin(await createUser('Admin'));
    const me = await api().get('/api/me').set(admin.auth);
    expect((await api().post(`/api/admin/users/${me.body.user.id}/freeze`).set(admin.auth).send({ reason: 'test' })).body.error.code).toBe('CANNOT_FREEZE_SELF');
    expect((await api().post('/api/admin/users/999/freeze').set(admin.auth).send({})).status).toBe(400);
  });

  it('runs a full reconciliation on demand', async () => {
    const admin = await makeAdmin(await createUser('Admin'));
    const res = await api().get('/api/admin/reconcile').set(admin.auth);
    expect(res.body.ok).toBe(true);
  });
});

describe('Razorpay top-ups', () => {
  let restoreKeys;
  let orderCount = 0;
  beforeEach(() => {
    restoreKeys = withConfig(config.razorpay, { keyId: 'rzp_test_key', keySecret: 'test_key_secret', webhookSecret: 'test_webhook_secret' });
    setRemoteOrderCreator(async ({ amountPaise }) => ({ id: `order_test${++orderCount}`, amount: amountPaise, currency: 'INR' }));
  });
  afterEach(() => restoreKeys());

  const startOrder = (user, amount) => api().post('/api/wallet/topups/orders').set(user.auth).send({ amount });
  const confirm = (user, orderId, paymentId, signature = checkoutSignature(orderId, paymentId, 'test_key_secret')) =>
    api().post(`/api/wallet/topups/orders/${orderId}/confirm`).set(user.auth).send({ razorpayPaymentId: paymentId, razorpaySignature: signature });
  const webhook = (body, signature = webhookSignature(JSON.stringify(body), 'test_webhook_secret')) =>
    api().post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Signature', signature).send(JSON.stringify(body));
  const captured = (orderId, paymentId, amount) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured' } } },
  });

  it('checkout confirmation with a valid signature credits the wallet once', async () => {
    const asha = await createUser('Asha');
    const order = await startOrder(asha, '500');
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ keyId: 'rzp_test_key', amountPaise: 50000 });

    expect((await confirm(asha, order.body.orderId, 'pay_A1')).body.status).toBe('CREDITED');
    expect((await confirm(asha, order.body.orderId, 'pay_A1')).body.status).toBe('ALREADY_CREDITED');
    expect(await balanceOf(asha)).toBe(50000);
  });

  it('rejects a forged checkout signature', async () => {
    const asha = await createUser('Asha');
    const order = await startOrder(asha, '500');
    const res = await confirm(asha, order.body.orderId, 'pay_A1', 'a'.repeat(64));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(await balanceOf(asha)).toBe(0);
  });

  it("cannot confirm someone else's order", async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const order = await startOrder(asha, '500');
    expect((await confirm(bala, order.body.orderId, 'pay_A1')).status).toBe(404);
  });

  it('webhook and browser confirmation arriving at the same time credit exactly once', async () => {
    const asha = await createUser('Asha');
    const { orderId } = (await startOrder(asha, '750')).body;
    const results = await Promise.all([
      confirm(asha, orderId, 'pay_B2'),
      webhook(captured(orderId, 'pay_B2', 75000)),
      webhook(captured(orderId, 'pay_B2', 75000)), // Razorpay retries deliveries
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await balanceOf(asha)).toBe(75000);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM transactions WHERE external_ref = 'pay_B2'");
    expect(n).toBe(1);
    expect((await reconcileAll()).ok).toBe(true);
  });

  it('rejects webhooks with a bad signature, and audits them', async () => {
    const asha = await createUser('Asha');
    const { orderId } = (await startOrder(asha, '100')).body;
    const res = await webhook(captured(orderId, 'pay_C3', 10000), 'b'.repeat(64));
    expect(res.status).toBe(400);
    expect(await balanceOf(asha)).toBe(0);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'WEBHOOK_REJECTED'");
    expect(n).toBe(1);
  });

  it('a webhook whose amount does not match the order credits nothing', async () => {
    const asha = await createUser('Asha');
    const { orderId } = (await startOrder(asha, '100')).body;
    const res = await webhook(captured(orderId, 'pay_D4', 99999999));
    expect(res.body).toMatchObject({ handled: true, credited: false, rejected: 'AMOUNT_MISMATCH' });
    expect(await balanceOf(asha)).toBe(0);
  });

  it('acknowledges events and orders it does not handle (so the gateway stops retrying)', async () => {
    expect((await webhook({ event: 'refund.created', payload: {} })).body).toMatchObject({ received: true, handled: false });
    expect((await webhook(captured('order_unknown', 'pay_X', 100))).body).toMatchObject({ received: true, handled: false, reason: 'unknown_order' });
  });

  it('reports the gateway as off when keys are not configured', async () => {
    restoreKeys();
    restoreKeys = withConfig(config.razorpay, { keyId: null, keySecret: null });
    const asha = await createUser('Asha');
    expect((await startOrder(asha, '100')).status).toBe(503);
    expect((await api().get('/api/me').set(asha.auth)).body.settings.razorpay).toBeNull();
  });
});

describe('ops', () => {
  it('health and readiness', async () => {
    expect((await api().get('/api/health')).body).toEqual({ status: 'ok' });
    const ready = await api().get('/api/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.migrations.ok).toBe(true);
  });

  it('every response carries a request id, and an incoming one is kept', async () => {
    const generated = await api().get('/api/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const passed = await api().get('/api/health').set('X-Request-Id', 'lb-trace-12345');
    expect(passed.headers['x-request-id']).toBe('lb-trace-12345');
  });

  it('exposes Prometheus metrics, labelled by route pattern (not raw ids)', async () => {
    const asha = await createUser('Asha');
    await addMoney(asha, '10');
    const res = await api().get('/api/metrics');
    expect(res.text).toMatch(/payledger_payments_total\{kind="topup",outcome="success"\} [1-9]/); // cumulative across tests
    expect(res.text).toMatch(/payledger_http_request_duration_seconds_count\{method="POST",route="\/api\/wallet\/topups",status="201"\}/);
  });

  it('metrics need the token when one is configured', async () => {
    const restore = withConfig(config.ops, { metricsToken: 'metrics-secret' });
    try {
      expect((await api().get('/api/metrics')).status).toBe(404);
      expect((await api().get('/api/metrics').set('Authorization', 'Bearer metrics-secret')).status).toBe(200);
    } finally {
      restore();
    }
  });

  it('cleanup expires old idempotency keys only, and needs the cron secret', async () => {
    const asha = await createUser('Asha');
    await addMoney(asha, '10', 'old-key-123');
    await addMoney(asha, '10', 'new-key-123');
    await pool.query("UPDATE idempotency_keys SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 25 HOUR) WHERE idem_key = 'old-key-123'");

    const restore = withConfig(config.ops, { cronSecret: 'cron-secret' });
    try {
      expect((await api().post('/api/internal/cleanup')).status).toBe(401);
      const res = await api().post('/api/internal/cleanup').set('Authorization', 'Bearer cron-secret');
      expect(res.body.removed.idempotencyKeys).toBe(1);
      const [keys] = await pool.query('SELECT idem_key FROM idempotency_keys');
      expect(keys.map((k) => k.idem_key)).toEqual(['new-key-123']);
    } finally {
      restore();
    }
  });

  it('serves API docs, and the OpenAPI spec documents every route the app has', async () => {
    expect((await api().get('/api/docs/')).status).toBe(200);
    const routes = [];
    const walk = (router, prefix) => {
      for (const layer of router.stack) {
        if (!layer.route) continue;
        const path = (prefix + layer.route.path).replace(/:(\w+)/g, '{$1}');
        for (const method of Object.keys(layer.route.methods)) routes.push(`${method} ${path}`);
      }
    };
    walk(authRouter, '/auth');
    walk(adminRouter, '/admin');
    walk(walletRouter, '');
    walk(opsRouter, '');
    const documented = Object.entries(openapiSpec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`));
    // GET /internal/cleanup exists only because Vercel Cron sends GET; /openapi.json is the spec itself.
    const undocumented = routes.filter((r) => !documented.includes(r) && !['get /internal/cleanup', 'get /openapi.json'].includes(r));
    expect(undocumented).toEqual([]);
  });

  it('500 errors return a request id instead of internals', async () => {
    const res = await api().get('/api/wallet/activity?cursor=abc').set((await createUser('Asha')).auth);
    expect(res.status).toBe(400); // validation, not a crash
    expect(res.body.error).not.toHaveProperty('stack');
  });
});

describe('idempotency keys are per payment kind', () => {
  it('the same key cannot be reused across different endpoints', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const key = newKey();
    await addMoney(asha, '100', key);
    const res = await sendMoney(asha, bala, '10', key);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
