import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.js'],
    fileParallelism: false, // all test files share one MySQL database
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'mysql://root:root@localhost:3306/payledger_test',
      JWT_SECRET: 'test-secret',
      BCRYPT_ROUNDS: '4',
      DB_POOL_SIZE: '20',
    },
  },
});
