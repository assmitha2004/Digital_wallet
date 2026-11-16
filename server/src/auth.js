import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { AUDIT, recordAudit } from './audit.js';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { requireAuth, requireClientHeader, validateBody } from './middleware.js';
import { loginLimiter } from './rateLimits.js';
import {
  REFRESH_COOKIE,
  cookieOptions,
  endAllSessions,
  endSession,
  issueAccessToken,
  listSessions,
  rotateRefreshToken,
  startSession,
} from './sessions.js';
import { generateSecret, otpauthUri, verifyTotp } from './totp.js';
import { consumeOtp } from './twoFactor.js';

const otpField = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.');

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase().max(255),
  password: z.string().min(8).max(72), // bcrypt only reads the first 72 bytes
});

const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(72),
  otp: otpField.optional(),
});

// Compared against when the email does not exist, so a missing user takes as long as a wrong
// password and response time does not reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 10);

const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, role: user.role ?? 'USER' });

function sendSession(res, status, { user, refreshToken }) {
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
  res.status(status).json({ accessToken: issueAccessToken(user), user: publicUser(user) });
}

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), async (req, res) => {
  const { name, email, password } = req.body;
  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);

  // User, wallet and first session are created together: never a user without a wallet.
  const session = await withTransaction(async (conn) => {
    let userId;
    try {
      const [userResult] = await conn.execute('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email, passwordHash]);
      userId = userResult.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      throw err;
    }
    await conn.execute("INSERT INTO wallets (user_id, kind) VALUES (?, 'USER')", [userId]);
    await recordAudit({ action: AUDIT.USER_REGISTERED, actorUserId: userId, targetType: 'user', targetId: userId, req }, conn);
    const refreshToken = await startSession(conn, userId, req);
    return { user: { id: userId, name, email, role: 'USER', token_version: 0 }, refreshToken };
  });
  sendSession(res, 201, session);
});

/**
 * Login, in order:
 *  1. Unknown email -> same error and timing as a wrong password.
 *  2. Locked account -> 423 until the lock expires (password not even checked).
 *  3. Wrong password, or wrong 2FA code -> count a failure; the 5th failure locks for 15 minutes.
 *  4. 2FA on but no code -> 401 OTP_REQUIRED, so the app can ask for it.
 *  5. Success -> reset the failure count, start a session.
 */
authRouter.post('/login', loginLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, password, otp } = req.body;
  const [[user]] = await pool.execute(
    `SELECT id, name, email, role, password_hash, token_version, totp_enabled, totp_secret,
            locked_until > CURRENT_TIMESTAMP(3) AS locked,
            CEIL(TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(3), locked_until) / 60) AS locked_minutes
       FROM users WHERE email = ?`,
    [email],
  );

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await recordAudit({ action: AUDIT.LOGIN_FAILED, req, metadata: { email, reason: 'unknown_email' } });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (user.locked) {
    throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${user.locked_minutes} minute(s).`);
  }

  const fail = async (reason, error) => {
    // One atomic UPDATE: concurrent wrong guesses cannot both slip under the limit.
    // locked_until is assigned first so both expressions read the OLD count (same on MySQL and TiDB).
    await pool.execute(
      `UPDATE users SET locked_until = IF(failed_login_count + 1 >= ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE), locked_until),
              failed_login_count = failed_login_count + 1
        WHERE id = ?`,
      [config.auth.maxFailedLogins, config.auth.lockMinutes, user.id],
    );
    const [[after]] = await pool.execute('SELECT failed_login_count, locked_until > CURRENT_TIMESTAMP(3) AS locked FROM users WHERE id = ?', [user.id]);
    await recordAudit({ action: AUDIT.LOGIN_FAILED, actorUserId: user.id, targetType: 'user', targetId: user.id, req, metadata: { reason } });
    if (after.locked) {
      await pool.execute('UPDATE users SET failed_login_count = 0 WHERE id = ?', [user.id]);
      await recordAudit({ action: AUDIT.ACCOUNT_LOCKED, actorUserId: user.id, targetType: 'user', targetId: user.id, req });
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${config.auth.lockMinutes} minute(s).`);
    }
    throw error;
  };

  if (!(await bcrypt.compare(password, user.password_hash))) {
    await fail('wrong_password', new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.'));
  }
  if (user.totp_enabled) {
    if (!otp) throw new AppError(401, 'OTP_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
    try {
      await consumeOtp(pool, user.id, otp, { secret: user.totp_secret });
    } catch (err) {
      await fail('wrong_otp', err);
    }
  }

  const refreshToken = await withTransaction(async (conn) => {
    await conn.execute('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?', [user.id]);
    await recordAudit({ action: AUDIT.LOGIN_SUCCEEDED, actorUserId: user.id, targetType: 'user', targetId: user.id, req }, conn);
    return startSession(conn, user.id, req);
  });
  sendSession(res, 200, { user, refreshToken });
});

/** New access token from the refresh cookie. The cookie itself is rotated every time. */
authRouter.post('/refresh', requireClientHeader, async (req, res) => {
  try {
    const session = await rotateRefreshToken(req.cookies?.[REFRESH_COOKIE], req);
    sendSession(res, 200, session);
  } catch (err) {
    if (err instanceof AppError && err.code !== 'SESSION_ALREADY_REFRESHED') res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw err;
  }
});

authRouter.post('/logout', requireClientHeader, async (req, res) => {
  const userId = await endSession(req.cookies?.[REFRESH_COOKIE]);
  if (userId) await recordAudit({ action: AUDIT.LOGOUT, actorUserId: userId, targetType: 'user', targetId: userId, req });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await withTransaction(async (conn) => {
    await endAllSessions(conn, req.userId);
    await recordAudit({ action: AUDIT.LOGOUT_ALL, actorUserId: req.userId, targetType: 'user', targetId: req.userId, req }, conn);
  });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/sessions', requireAuth, async (req, res) => {
  res.json({ items: await listSessions(req.userId) });
});

// ---- Two-factor authentication (TOTP) -------------------------------------------------------

/** Step 1: create a secret. It is not active until a correct code proves the app has it. */
authRouter.post('/2fa/setup', requireAuth, async (req, res) => {
  const [[user]] = await pool.execute('SELECT email, totp_enabled FROM users WHERE id = ?', [req.userId]);
  if (user.totp_enabled) throw new AppError(409, 'TWO_FACTOR_ALREADY_ON', 'Two-step verification is already on.');
  const secret = generateSecret();
  await pool.execute('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, req.userId]);
  res.json({ secret, otpauthUrl: otpauthUri({ secret, accountName: user.email }) });
});

/** Step 2: turn it on with a code from the app. */
authRouter.post('/2fa/enable', requireAuth, validateBody(z.object({ code: otpField })), async (req, res) => {
  const [[user]] = await pool.execute('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [req.userId]);
  if (user.totp_enabled) throw new AppError(409, 'TWO_FACTOR_ALREADY_ON', 'Two-step verification is already on.');
  if (!user.totp_secret) throw new AppError(409, 'TWO_FACTOR_NOT_SET_UP', 'Start the setup first.');
  if (verifyTotp(user.totp_secret, req.body.code) === null) {
    throw new AppError(401, 'INVALID_OTP', 'That code is not correct. Check the time on your phone and try again.');
  }
  await withTransaction(async (conn) => {
    await conn.execute('UPDATE users SET totp_enabled = 1 WHERE id = ?', [req.userId]);
    await recordAudit({ action: AUDIT.TWO_FACTOR_ENABLED, actorUserId: req.userId, targetType: 'user', targetId: req.userId, req }, conn);
  });
  res.json({ twoFactorEnabled: true });
});

/** Turning it off needs both the password and a current code. */
authRouter.post(
  '/2fa/disable',
  requireAuth,
  validateBody(z.object({ password: z.string().min(1).max(72), code: otpField })),
  async (req, res) => {
    const [[user]] = await pool.execute('SELECT password_hash, totp_enabled, totp_secret FROM users WHERE id = ?', [req.userId]);
    if (!user.totp_enabled) throw new AppError(409, 'TWO_FACTOR_OFF', 'Two-step verification is not on.');
    if (!(await bcrypt.compare(req.body.password, user.password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is incorrect.');
    }
    await consumeOtp(pool, req.userId, req.body.code, { secret: user.totp_secret });
    await withTransaction(async (conn) => {
      await conn.execute('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?', [req.userId]);
      await recordAudit({ action: AUDIT.TWO_FACTOR_DISABLED, actorUserId: req.userId, targetType: 'user', targetId: req.userId, req }, conn);
    });
    res.json({ twoFactorEnabled: false });
  },
);
