import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

// Redis is optional. It is used to share rate-limit counters between instances
// (serverless functions or several containers). Without REDIS_URL, counters are per process.
let client = null;

export function getRedis() {
  if (!config.redisUrl) return null;
  if (!client) {
    // Commands wait for the connection briefly (offline queue), then fail fast: the rate limiter
    // lets the request through when Redis cannot answer (see rateLimits.js).
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
    client.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
  }
  return client;
}

export async function closeRedis() {
  if (client) {
    await client.quit().catch(() => client.disconnect());
    client = null;
  }
}
