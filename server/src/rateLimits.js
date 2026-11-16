import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from './config.js';
import { getRedis } from './redis.js';

/**
 * Rate limiters. With REDIS_URL set, counters live in Redis and are shared by every instance;
 * otherwise each process counts on its own (fine for one container, weak on serverless).
 * If Redis is unreachable, requests are allowed rather than blocked (passOnStoreError): an
 * outage of the limiter should not become an outage of payments.
 */
function makeLimiter({ name, windowMs, limit, keyGenerator, message }) {
  const redis = getRedis();
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    passOnStoreError: true,
    skip: () => !config.rateLimits.enabled,
    keyGenerator,
    store: redis
      ? new RedisStore({ prefix: `rl:${name}:`, sendCommand: (command, ...args) => redis.call(command, ...args) })
      : undefined,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message } }),
  });
}

const byIp = (req) => ipKeyGenerator(req.ip ?? '');

/** Everything under /api, per client IP. */
export const apiLimiter = makeLimiter({
  name: 'api',
  windowMs: 60_000,
  limit: config.rateLimits.apiPerMinute,
  keyGenerator: byIp,
  message: 'Too many requests. Slow down and try again in a minute.',
});

/** Password guessing, per IP. (Per-account guessing is stopped by the account lockout.) */
export const loginLimiter = makeLimiter({
  name: 'login',
  windowMs: 15 * 60_000,
  limit: config.rateLimits.loginsPer15Min,
  keyGenerator: byIp,
  message: 'Too many login attempts. Try again in 15 minutes.',
});

/** Money-moving requests, per user (runs after requireAuth). */
export const paymentLimiter = makeLimiter({
  name: 'payments',
  windowMs: 60_000,
  limit: config.rateLimits.paymentsPerMinute,
  keyGenerator: (req) => `user:${req.userId}`,
  message: 'Too many payments in a minute. Wait a moment and try again.',
});
