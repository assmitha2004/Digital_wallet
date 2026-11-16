import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { appliedVersion, latestVersion } from '../scripts/migrate.js';
import { config } from './config.js';
import { pool } from './db.js';
import { AppError } from './errors.js';
import { handleWebhook } from './gateway.js';
import { logger } from './logger.js';
import { runCleanup } from './maintenance.js';
import { registry } from './metrics.js';
import { getRedis } from './redis.js';

export const opsRouter = Router();

/** Liveness: the process is up. No dependencies, so a slow database never restarts healthy pods. */
opsRouter.get('/health', (_req, res) => res.json({ status: 'ok' }));

/**
 * Readiness: can this instance serve traffic? Checks the database, that all migrations are
 * applied, and Redis if configured. A load balancer stops sending traffic while this is 503.
 */
opsRouter.get('/ready', async (_req, res) => {
  const checks = {};
  try {
    const started = performance.now();
    await pool.query('SELECT 1');
    checks.database = { ok: true, ms: Math.round(performance.now() - started) };
    const version = await appliedVersion(pool);
    checks.migrations = { ok: version >= latestVersion(), applied: version, latest: latestVersion() };
  } catch (err) {
    checks.database = { ok: false, error: err.code ?? 'UNREACHABLE' };
  }
  const redis = getRedis();
  if (redis) {
    try {
      // Never let a hung dependency hang the readiness probe itself.
      await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1000))]);
      checks.redis = { ok: true };
    } catch {
      checks.redis = { ok: false };
    }
  }
  const ok = Object.values(checks).every((check) => check.ok);
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', checks });
});

/** Constant-time check of "Authorization: Bearer <secret>". */
function bearerMatches(req, secret) {
  if (!secret) return false;
  const given = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer /, ''));
  const expected = Buffer.from(secret);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Prometheus metrics. Needs METRICS_TOKEN in production (metrics reveal traffic patterns). */
opsRouter.get('/metrics', async (req, res) => {
  if (config.isProduction || config.ops.metricsToken) {
    if (!bearerMatches(req, config.ops.metricsToken)) throw new AppError(404, 'NOT_FOUND', 'No such endpoint.');
  }
  res.set('Content-Type', registry.contentType).send(await registry.metrics());
});

/** Daily housekeeping, called by Vercel Cron with "Authorization: Bearer $CRON_SECRET". */
const runCleanupRoute = async (req, res) => {
  if (!bearerMatches(req, config.ops.cronSecret)) throw new AppError(401, 'UNAUTHENTICATED', 'Bad cron secret.');
  const removed = await runCleanup();
  logger.info({ removed }, 'cleanup finished');
  res.json({ removed });
};
opsRouter.get('/internal/cleanup', runCleanupRoute); // Vercel Cron sends GET
opsRouter.post('/internal/cleanup', runCleanupRoute);

/**
 * Razorpay webhook. Needs the RAW body: the signature is computed over the exact bytes sent,
 * and re-serialising parsed JSON can change them. Mounted before the global JSON parser.
 */
opsRouter.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  const outcome = await handleWebhook({ rawBody: Buffer.isBuffer(req.body) ? req.body : null, signature: req.get('x-razorpay-signature'), req });
  res.json({ received: true, ...outcome });
});

// ---- API documentation ----------------------------------------------------------------------
const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../openapi.yaml');
export const openapiSpec = YAML.parse(fs.readFileSync(specPath, 'utf8'));

opsRouter.get('/openapi.json', (_req, res) => res.json(openapiSpec));
opsRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'PayLedger API' }));
