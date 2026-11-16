// Sessions: short-lived access tokens (JWT) + long-lived, rotating refresh tokens (cookie).
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { AUDIT, recordAudit } from './audit.js';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { AppError } from './errors.js';

export const REFRESH_COOKIE = 'pl_refresh';
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The access token carries the user's token_version; "log out everywhere" bumps it. */
export function issueAccessToken(user) {
  return jwt.sign({ ver: user.token_version ?? 0 }, config.auth.jwtSecret, {
    subject: String(user.id),
    expiresIn: config.auth.accessTokenTtl,
  });
}

export function cookieOptions() {
  return {
    httpOnly: true, // JavaScript in the page can never read it, so XSS cannot steal it
    secure: config.auth.cookieSecure,
    sameSite: 'strict', // never sent on requests started by another site (CSRF)
    path: '/api/auth', // only sent to the auth endpoints, not to every API call
    maxAge: config.auth.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
  };
}

async function insertRefreshToken(conn, { userId, familyId, req }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const [result] = await conn.execute(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? DAY), ?, ?)`,
    [userId, familyId, sha256(token), config.auth.refreshTokenTtlDays, req?.get?.('user-agent')?.slice(0, 255) ?? null, req?.ip ?? null],
  );
  return { token, id: result.insertId };
}

/** Starts a new session (a new token family) after login or registration. */
export async function startSession(conn, userId, req) {
  const { token } = await insertRefreshToken(conn, { userId, familyId: crypto.randomUUID(), req });
  return token;
}

/**
 * Exchanges a refresh token for a new one (rotation). Each token works once.
 *
 *  - valid and unused  -> revoke it, issue a new token in the same family
 *  - already rotated, within a few seconds -> two tabs refreshed at once: reject this one quietly
 *  - already rotated, later -> the token was copied and replayed: revoke the WHOLE family
 *  - unknown or expired -> reject
 *
 * The row is locked FOR UPDATE, so two simultaneous refreshes with one token cannot both succeed.
 */
export async function rotateRefreshToken(rawToken, req) {
  if (!rawToken) throw new AppError(401, 'NO_SESSION', 'Log in first.');
  const outcome = await withTransaction(async (conn) => {
    const [[row]] = await conn.execute(
      `SELECT id, user_id, family_id, revoked_at, replaced_by, expires_at < CURRENT_TIMESTAMP(3) AS expired,
              TIMESTAMPDIFF(MICROSECOND, revoked_at, CURRENT_TIMESTAMP(3)) / 1000 AS revoked_ms_ago
         FROM refresh_tokens WHERE token_hash = ? FOR UPDATE`,
      [sha256(rawToken)],
    );
    if (!row) return { error: new AppError(401, 'NO_SESSION', 'Your session has ended. Log in again.') };

    if (row.revoked_at) {
      if (row.replaced_by && row.revoked_ms_ago <= config.auth.refreshRaceGraceMs) {
        return { error: new AppError(401, 'SESSION_ALREADY_REFRESHED', 'This session was just refreshed in another tab.') };
      }
      await conn.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE family_id = ? AND revoked_at IS NULL', [
        row.family_id,
      ]);
      await recordAudit(
        { action: AUDIT.REFRESH_TOKEN_REUSED, actorUserId: row.user_id, targetType: 'user', targetId: row.user_id, req, metadata: { familyId: row.family_id } },
        conn,
      );
      // Commit the revocation, then report the error (throwing here would roll it back).
      return { error: new AppError(401, 'SESSION_REVOKED', 'For your safety this session was ended. Log in again.') };
    }
    if (row.expired) return { error: new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Log in again.') };

    const next = await insertRefreshToken(conn, { userId: row.user_id, familyId: row.family_id, req });
    await conn.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3), replaced_by = ? WHERE id = ?', [next.id, row.id]);
    const [[user]] = await conn.execute('SELECT id, name, email, role, token_version FROM users WHERE id = ?', [row.user_id]);
    return { user, refreshToken: next.token };
  });
  if (outcome.error) throw outcome.error;
  return outcome;
}

/** Logs out the session that owns this refresh token (its whole family). */
export async function endSession(rawToken) {
  if (!rawToken) return null;
  const [[row]] = await pool.execute('SELECT user_id, family_id FROM refresh_tokens WHERE token_hash = ?', [sha256(rawToken)]);
  if (!row) return null;
  await pool.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE family_id = ? AND revoked_at IS NULL', [row.family_id]);
  return row.user_id;
}

/** "Log out everywhere": revokes every refresh token and invalidates every access token. */
export async function endAllSessions(conn, userId) {
  await conn.execute('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  await conn.execute('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [userId]);
}

/** Active sessions for the security page. */
export async function listSessions(userId) {
  const [rows] = await pool.execute(
    `SELECT family_id, MIN(created_at) AS started_at, MAX(created_at) AS last_refreshed_at,
            SUBSTRING_INDEX(GROUP_CONCAT(user_agent ORDER BY id DESC SEPARATOR '\n'), '\n', 1) AS user_agent,
            SUBSTRING_INDEX(GROUP_CONCAT(ip ORDER BY id DESC SEPARATOR '\n'), '\n', 1) AS ip
       FROM refresh_tokens
      WHERE user_id = ? AND family_id IN (
            SELECT family_id FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3))
      GROUP BY family_id ORDER BY last_refreshed_at DESC`,
    [userId, userId],
  );
  return rows.map((row) => ({ id: row.family_id, startedAt: row.started_at, lastActiveAt: row.last_refreshed_at, userAgent: row.user_agent, ip: row.ip }));
}
