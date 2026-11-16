import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { adminRouter } from './adminRoutes.js';
import { authRouter } from './auth.js';
import { badRequest } from './errors.js';
import { httpLogger } from './logger.js';
import { metricsMiddleware } from './metrics.js';
import { errorHandler, notFound } from './middleware.js';
import { opsRouter } from './opsRoutes.js';
import { apiLimiter } from './rateLimits.js';
import { walletRouter } from './walletRoutes.js';

export const app = express();

app.set('trust proxy', 1); // correct client IP behind Vercel / nginx (rate limits, audit log)
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // Razorpay Checkout loads its script and opens its payment frame from these hosts.
        'script-src': ["'self'", 'https://checkout.razorpay.com'],
        'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
        'connect-src': ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
        'img-src': ["'self'", 'data:', 'https:'],
      },
    },
  }),
);
app.use(httpLogger);
app.use(metricsMiddleware);
app.use(cookieParser());

const api = express.Router();
api.use(apiLimiter);
// Ops routes come before the JSON parser: the payment webhook must read the raw body.
api.use(opsRouter);
api.use(express.json({ limit: '10kb' }));
api.use('/auth', authRouter);
api.use('/admin', adminRouter);
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

// Query-string and URL-parameter validation errors from zod `.parse()` become 400s.
app.use((err, _req, _res, next) => next(err instanceof ZodError ? badRequest('VALIDATION_FAILED', 'Invalid request parameters.') : err));
app.use(errorHandler);

export default app;
