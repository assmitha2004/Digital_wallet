import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db.js';
import { currentStep } from '../src/totp.js';
import {
  addMoney,
  api,
  codeFor,
  config,
  createUser,
  enableTwoFactor,
  login,
  newKey,
  refreshWith,
  resetDatabase,
  sendMoney,
  withConfig,
} from './helpers.js';

beforeEach(async () => {
  await resetDatabase();
  // Pin the clock to the middle of a 30-second TOTP step, so codes cannot roll over mid-test.
  const middleOfStep = (currentStep(Date.now()) * 30 + 15) * 1000;
  vi.spyOn(Date, 'now').mockReturnValue(middleOfStep);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

describe('sessions: access token + rotating refresh cookie', () => {
  it('sets an httpOnly, SameSite=Strict refresh cookie scoped to /api/auth', async () => {
    await createUser('Asha');
    const res = await login('asha@test.dev');
    expect(res.status).toBe(200);
    const cookie = res.cookie.join(';');
    expect(cookie).toMatch(/pl_refresh=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(res.body).not.toHaveProperty('refreshToken'); // never readable by page JavaScript
  });

  it('rotates: each refresh token works once and returns a new one', async () => {
    await createUser('Asha');
    const first = await login('asha@test.dev');
    const r1 = await refreshWith(first.cookie);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    const r2 = await refreshWith(r1.headers['set-cookie']);
    expect(r2.status).toBe(200);
  });

  it('needs the X-PayLedger-Client header (CSRF defence)', async () => {
    await createUser('Asha');
    const { cookie } = await login('asha@test.dev');
    const res = await api().post('/api/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CLIENT_HEADER_REQUIRED');
  });

  it('two tabs refreshing with the same token at once: one wins, the session survives', async () => {
    await createUser('Asha');
    const { cookie } = await login('asha@test.dev');
    const [a, b] = await Promise.all([refreshWith(cookie), refreshWith(cookie)]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const loser = a.status === 401 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.body.error.code).toBe('SESSION_ALREADY_REFRESHED');
    expect((await refreshWith(winner.headers['set-cookie'])).status).toBe(200); // not revoked
  });

  it('a stolen, already-used refresh token revokes the whole session (theft detection)', async () => {
    const restore = withConfig(config.auth, { refreshRaceGraceMs: 0 });
    try {
      await createUser('Asha');
      const { cookie: stolen } = await login('asha@test.dev');
      const legit = await refreshWith(stolen); // the real user refreshes; `stolen` is now used
      const replay = await refreshWith(stolen); // the attacker replays the copy
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('SESSION_REVOKED');
      // The real user's newer token was in the same family, so it is dead too: both must log in again.
      expect((await refreshWith(legit.headers['set-cookie'])).status).toBe(401);
      // Both uses of a revoked token are recorded (the attacker's replay, then the real user's).
      const [[audit]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'REFRESH_TOKEN_REUSED'");
      expect(audit.n).toBe(2);
    } finally {
      restore();
    }
  });

  it('logout ends the session; log out everywhere also kills live access tokens', async () => {
    await createUser('Asha');
    const phone = await login('asha@test.dev');
    const laptop = await login('asha@test.dev');
    expect((await api().get('/api/auth/sessions').set(laptop.auth)).body.items).toHaveLength(3); // + registration session

    await api().post('/api/auth/logout').set('Cookie', phone.cookie).set('X-PayLedger-Client', 'test').expect(204);
    expect((await refreshWith(phone.cookie)).status).toBe(401);
    expect((await api().get('/api/me').set(laptop.auth)).status).toBe(200);

    await api().post('/api/auth/logout-all').set(laptop.auth).expect(204);
    const after = await api().get('/api/me').set(laptop.auth);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_REVOKED');
    expect((await refreshWith(laptop.cookie)).status).toBe(401);
  });
});

describe('login protection', () => {
  it('locks the account after 5 wrong passwords, even with the right password afterwards', async () => {
    await createUser('Asha');
    for (let i = 0; i < 4; i++) expect((await login('asha@test.dev', 'wrong-password')).status).toBe(401);
    const fifth = await login('asha@test.dev', 'wrong-password');
    expect(fifth.status).toBe(423);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');
    expect((await login('asha@test.dev')).status).toBe(423);

    // After the lock expires, the right password works and the counter starts again.
    await pool.query("UPDATE users SET locked_until = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE email = 'asha@test.dev'");
    expect((await login('asha@test.dev')).status).toBe(200);
    const [[row]] = await pool.query("SELECT failed_login_count FROM users WHERE email = 'asha@test.dev'");
    expect(row.failed_login_count).toBe(0);
  });

  it('concurrent wrong guesses cannot slip past the limit', async () => {
    await createUser('Asha');
    const results = await Promise.all(Array.from({ length: 12 }, () => login('asha@test.dev', 'wrong-password')));
    expect(results.filter((r) => r.status === 423).length).toBeGreaterThanOrEqual(7);
    expect((await login('asha@test.dev')).status).toBe(423);
  });

  it('records logins in the audit log, and shows them to the user', async () => {
    const asha = await createUser('Asha');
    await login('asha@test.dev', 'wrong-password');
    await login('asha@test.dev');
    const events = await api().get('/api/me/security-events').set(asha.auth);
    expect(events.body.items.map((e) => e.action)).toEqual(['LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'USER_REGISTERED']);
    expect(events.body.items[0].requestId).toBeTruthy();
  });

  it('rate-limits login attempts per IP when limits are on', async () => {
    const { loginLimiter } = await import('../src/rateLimits.js');
    const restore = withConfig(config.rateLimits, { enabled: true });
    try {
      const statuses = [];
      for (let i = 0; i < 11; i++) statuses.push((await login('nobody@test.dev', 'x')).status);
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      restore();
      await loginLimiter.resetKey('::ffff:127.0.0.1');
      await loginLimiter.resetKey('127.0.0.1');
    }
  });
});

describe('two-step verification (TOTP)', () => {
  it('setup -> enable with a code -> login then needs the code', async () => {
    const asha = await createUser('Asha');
    const secret = await enableTwoFactor(asha);
    expect((await api().get('/api/me').set(asha.auth)).body.user.twoFactorEnabled).toBe(true);

    const noCode = await login('asha@test.dev');
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('OTP_REQUIRED');
    expect((await login('asha@test.dev', 'password123', codeFor(secret, 1))).status).toBe(200);
  });

  it('the same code cannot be used twice', async () => {
    const asha = await createUser('Asha');
    const secret = await enableTwoFactor(asha);
    const code = codeFor(secret, 1);
    expect((await login('asha@test.dev', 'password123', code)).status).toBe(200);
    const again = await login('asha@test.dev', 'password123', code);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('OTP_ALREADY_USED');
  });

  it('a wrong code counts as a failed login', async () => {
    const asha = await createUser('Asha');
    await enableTwoFactor(asha);
    expect((await login('asha@test.dev', 'password123', '000000')).body.error.code).toBe('INVALID_OTP');
    const [[row]] = await pool.query("SELECT failed_login_count FROM users WHERE email = 'asha@test.dev'");
    expect(row.failed_login_count).toBe(1);
  });

  it('turning it off needs the password and a code', async () => {
    const asha = await createUser('Asha');
    const secret = await enableTwoFactor(asha);
    expect((await api().post('/api/auth/2fa/disable').set(asha.auth).send({ password: 'nope', code: codeFor(secret, 1) })).status).toBe(401);
    expect((await api().post('/api/auth/2fa/disable').set(asha.auth).send({ password: 'password123', code: codeFor(secret, 1) })).status).toBe(200);
    expect((await login('asha@test.dev')).status).toBe(200);
  });
});

describe('step-up: large transfers need a 2FA code', () => {
  let restore;
  beforeEach(() => {
    restore = withConfig(config, { stepUpThresholdPaise: 10_000_00 }); // ₹10,000
  });
  afterEach(() => restore());

  it('small transfers do not need a code', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '20000');
    expect((await sendMoney(asha, bala, '9999.99')).status).toBe(201);
  });

  it('without 2FA turned on, large transfers are refused', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    await addMoney(asha, '20000');
    const res = await sendMoney(asha, bala, '10000');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TWO_FACTOR_REQUIRED');
  });

  it('with 2FA: refused without a code, accepted with one', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const secret = await enableTwoFactor(asha);
    await addMoney(asha, '20000');

    expect((await sendMoney(asha, bala, '10000')).body.error.code).toBe('OTP_REQUIRED');
    const ok = await api()
      .post('/api/transfers')
      .set(asha.auth)
      .set('Idempotency-Key', newKey())
      .send({ toEmail: bala.email, amount: '10000', otp: codeFor(secret, 1) });
    expect(ok.status).toBe(201);
  });

  it('a retry of the same payment with a newer code is a replay, not a second payment', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const secret = await enableTwoFactor(asha);
    await addMoney(asha, '30000');
    const key = newKey();
    const send = (otp) => api().post('/api/transfers').set(asha.auth).set('Idempotency-Key', key).send({ toEmail: bala.email, amount: '10000', otp });

    expect((await send(codeFor(secret, 1))).status).toBe(201);
    const retry = await send(codeFor(secret, -1)); // different code, same payment
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM transactions WHERE type = 'TRANSFER'");
    expect(n).toBe(1);
  });

  it('one code cannot authorise two different payments sent at the same moment', async () => {
    const asha = await createUser('Asha');
    const bala = await createUser('Bala');
    const secret = await enableTwoFactor(asha);
    await addMoney(asha, '40000');
    const code = codeFor(secret, 1);
    const results = await Promise.all(
      [1, 2].map(() => api().post('/api/transfers').set(asha.auth).set('Idempotency-Key', newKey()).send({ toEmail: bala.email, amount: '10000', otp: code })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
    expect(results.find((r) => r.status === 401).body.error.code).toBe('OTP_ALREADY_USED');
  });
});
