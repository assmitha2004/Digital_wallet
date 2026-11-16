import crypto from 'node:crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { config } from './config.js';

// Structured JSON logs. Secrets and personal data are redacted before anything is written.
export const logger = pino({
  level: config.logLevel,
  base: { service: 'payledger' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.otp',
      '*.code',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
});

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * One log line per request, with a request id that is:
 *  - taken from an incoming X-Request-Id header (from a load balancer) when it looks safe,
 *  - otherwise generated,
 *  - returned in the X-Request-Id response header, so a user can quote it in a bug report,
 *  - attached to error logs and audit-log rows, so one id finds everything about a request.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/api/metrics' },
});
