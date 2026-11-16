import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError, badRequest } from './errors.js';
import { logger } from './logger.js';

/**
 * Requires "Authorization: Bearer <access token>".
 *
 * The token's signature and expiry are checked first (no database). Then one primary-key lookup
 * confirms the user still exists and the token's version matches users.token_version, so
 * "log out everywhere" takes effect immediately instead of when the token expires.
 * Sets req.userId and req.user = { id, role }.
 */
export async function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(new AppError(401, 'UNAUTHENTICATED', 'Log in first.'));
  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return next(new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired. Log in again.'));
  }
  try {
    const [[user]] = await pool.execute('SELECT id, role, token_version FROM users WHERE id = ?', [Number(payload.sub)]);
    if (!user || user.token_version !== (payload.ver ?? 0)) {
      return next(new AppError(401, 'SESSION_REVOKED', 'You were logged out. Log in again.'));
    }
    req.userId = user.id;
    req.user = { id: user.id, role: user.role };
    return next();
  } catch (err) {
    return next(err);
  }
}

/** Use after requireAuth. */
export const requireRole = (role) => (req, _res, next) =>
  req.user?.role === role ? next() : next(new AppError(403, 'FORBIDDEN', 'You do not have access to this.'));

/** Validates req.body with a zod schema and replaces it with the parsed value. */
export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
      return next(badRequest('VALIDATION_FAILED', 'Some fields are invalid.', details));
    }
    req.body = result.data;
    return next();
  };
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Every money-moving request must carry an Idempotency-Key header. */
export function requireIdempotencyKey(req, _res, next) {
  const key = req.get('idempotency-key');
  if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return next(badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8-64 letters, digits, - or _).'));
  }
  req.idempotencyKey = key;
  return next();
}

/**
 * Cookie-authenticated endpoints (refresh, logout) also need this header. A form or image on
 * another site cannot add custom headers without a CORS preflight, which this API never allows.
 * It backs up SameSite=Strict on the cookie (defence in depth against CSRF).
 */
export function requireClientHeader(req, _res, next) {
  return req.get('x-payledger-client') ? next() : next(new AppError(403, 'CLIENT_HEADER_REQUIRED', 'Missing X-PayLedger-Client header.'));
}

export function notFound(_req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', 'No such endpoint.'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) return res.status(err.status).json(err.toBody());
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }
  (req.log ?? logger).error({ err, requestId: req.id }, 'unhandled error');
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please retry.', requestId: req.id } });
}
