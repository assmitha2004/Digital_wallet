import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { AppError, badRequest } from './errors.js';

/** Requires "Authorization: Bearer <token>" and puts the user id on req.userId. */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next(new AppError(401, 'UNAUTHENTICATED', 'Log in first.'));
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = Number(payload.sub);
    return next();
  } catch {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Log in again.'));
  }
}

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

export function notFound(_req, _res, next) {
  next(new AppError(404, 'NOT_FOUND', 'No such endpoint.'));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) return res.status(err.status).json(err.toBody());
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please retry.' } });
}
