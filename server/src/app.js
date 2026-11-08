import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { authRouter } from './auth.js';
import { pool } from './db.js';
import { badRequest } from './errors.js';
import { errorHandler, notFound } from './middleware.js';
import { walletRouter } from './walletRoutes.js';

export const app = express();

app.set('trust proxy', 1); // correct client IP behind Vercel / nginx (used by the login rate limiter)
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

const api = express.Router();
api.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
});
api.use('/auth', authRouter);
api.use(walletRouter);
api.use(notFound);

app.use('/api', api);

// In Docker / `npm start` the API also serves the built React app. On Vercel, static files
// are served by the CDN instead and this folder is not present in the function bundle.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

// Query-string validation errors from zod `.parse()` become 400s.
app.use((err, _req, _res, next) => next(err instanceof ZodError ? badRequest('VALIDATION_FAILED', 'Invalid query.') : err));
app.use(errorHandler);

export default app;
