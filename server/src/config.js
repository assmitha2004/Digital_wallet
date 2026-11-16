import 'dotenv/config';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

const env = process.env;
const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';
const rupeesToPaiseInt = (rupees) => Math.round(Number(rupees) * 100);

// Hosted providers often hand out a connection string ending in a system schema (TiDB: "/sys").
// The app must never write there, so in that case (or when no database is named) use "payledger".
const SYSTEM_SCHEMAS = new Set(['', 'sys', 'mysql', 'information_schema', 'performance_schema', 'test']);
export function resolveDatabaseUrl(rawUrl) {
  const url = new URL(rawUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (env.DB_NAME) url.pathname = `/${env.DB_NAME}`;
  else if (SYSTEM_SCHEMAS.has(name.toLowerCase())) url.pathname = '/payledger';
  return url.toString();
}

export const config = {
  isProduction,
  isTest,
  port: Number(env.PORT ?? 4000),
  logLevel: env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
  databaseUrl: resolveDatabaseUrl(required('DATABASE_URL', 'mysql://root:root@localhost:3306/payledger')),
  // Hosted MySQL (Aiven, PlanetScale, TiDB ...) needs TLS. DB_CA_CERT is the PEM text if the
  // provider uses its own certificate authority.
  dbSsl: env.DB_SSL === 'true',
  dbCaCert: env.DB_CA_CERT,
  dbPoolSize: Number(env.DB_POOL_SIZE ?? 10),
  redisUrl: env.REDIS_URL || null, // optional: shared rate limits across instances

  auth: {
    jwtSecret: required('JWT_SECRET', isProduction ? undefined : 'dev-only-secret-change-me'),
    // Short-lived access token, kept in memory by the browser. The long-lived refresh token
    // lives in an httpOnly cookie that JavaScript cannot read.
    accessTokenTtl: env.ACCESS_TOKEN_TTL ?? '15m',
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    // A second refresh with an already-rotated token inside this window is treated as two tabs
    // refreshing at once (rejected, but not treated as theft).
    refreshRaceGraceMs: 30_000,
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction,
    bcryptRounds: Number(env.BCRYPT_ROUNDS ?? 10),
    maxFailedLogins: Number(env.MAX_FAILED_LOGINS ?? 5),
    lockMinutes: Number(env.LOCK_MINUTES ?? 15),
  },

  // Transfers at or above this amount need a code from the user's authenticator app.
  stepUpThresholdPaise: rupeesToPaiseInt(env.STEP_UP_THRESHOLD_RUPEES ?? 10_000),

  limits: {
    // All limits in paise.
    maxTopupPaise: 50_000_00, // ₹50,000 per top-up
    maxTransferPaise: 1_00_000_00, // ₹1,00,000 per transfer
    dailyTransferPaise: 2_00_000_00, // ₹2,00,000 sent per day (IST)
    maxPendingRequests: 20, // open "request money" asks per user
  },

  rateLimits: {
    enabled: env.RATE_LIMITS ? env.RATE_LIMITS === 'on' : !isTest,
    apiPerMinute: Number(env.RATE_LIMIT_API_PER_MINUTE ?? 300), // per IP
    paymentsPerMinute: Number(env.RATE_LIMIT_PAYMENTS_PER_MINUTE ?? 30), // per user
    loginsPer15Min: 10, // per IP
  },

  // Retries with the same Idempotency-Key are recognised for this long (Stripe uses 24 hours too).
  idempotencyKeyTtlHours: Number(env.IDEMPOTENCY_KEY_TTL_HOURS ?? 24),

  ops: {
    metricsToken: env.METRICS_TOKEN || null, // required to read /api/metrics in production
    cronSecret: env.CRON_SECRET || null, // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>"
  },

  topups: {
    // The simulated gateway stays on for the public demo unless switched off.
    allowSimulated: env.ALLOW_SIMULATED_TOPUPS !== 'false',
  },

  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || null,
    keySecret: env.RAZORPAY_KEY_SECRET || null,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || null,
    apiBase: env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com/v1',
  },

  adminEmail: env.ADMIN_EMAIL?.trim().toLowerCase() || null, // promoted to ADMIN by `npm run seed`
};

export const razorpayEnabled = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);
