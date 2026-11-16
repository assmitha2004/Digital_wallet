import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { logger } from './logger.js';
import { closeRedis } from './redis.js';

const server = app.listen(config.port, () => {
  logger.info(`PayLedger API listening on http://localhost:${config.port}`);
});

/**
 * Graceful shutdown (Docker / Kubernetes send SIGTERM before stopping a container):
 *  1. stop accepting new connections,
 *  2. let requests already running finish (a payment half-way through a transaction completes),
 *  3. close the database pool and Redis,
 *  4. exit. If something hangs, force-exit after 10 seconds.
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 10_000);
  force.unref();
  server.close(async () => {
    await pool.end().catch(() => {});
    await closeRedis();
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
