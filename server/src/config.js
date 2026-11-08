import 'dotenv/config';

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL', 'mysql://root:root@localhost:3306/payledger'),
  // Hosted MySQL (Aiven, PlanetScale, TiDB ...) needs TLS. DB_CA_CERT is the PEM text if the
  // provider uses its own certificate authority.
  dbSsl: process.env.DB_SSL === 'true',
  dbCaCert: process.env.DB_CA_CERT,
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 10),
  jwtSecret: required('JWT_SECRET', isProduction ? undefined : 'dev-only-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '2h',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 10),
  limits: {
    // All limits in paise.
    maxTopupPaise: 50_000_00,          // ₹50,000 per top-up
    maxTransferPaise: 1_00_000_00,     // ₹1,00,000 per transfer
    dailyTransferPaise: 2_00_000_00,   // ₹2,00,000 sent per day (IST)
  },
};
