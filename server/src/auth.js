import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { validateBody } from './middleware.js';

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.email().trim().toLowerCase().max(255),
  password: z.string().min(8).max(72), // bcrypt only reads the first 72 bytes
});

const loginSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1).max(72),
});

function issueToken(userId) {
  return jwt.sign({}, config.jwtSecret, { subject: String(userId), expiresIn: config.jwtExpiresIn });
}

// Slows down password guessing: 10 login attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req, res) =>
    res.status(429).json({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again in 15 minutes.' } }),
});

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), async (req, res) => {
  const { name, email, password } = req.body;
  const passwordHash = await bcrypt.hash(password, config.bcryptRounds);

  // User and wallet are created together: there is never a user without a wallet.
  const userId = await withTransaction(async (conn) => {
    try {
      const [userResult] = await conn.execute('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [
        name,
        email,
        passwordHash,
      ]);
      await conn.execute("INSERT INTO wallets (user_id, kind) VALUES (?, 'USER')", [userResult.insertId]);
      return userResult.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
      throw err;
    }
  });

  res.status(201).json({ token: issueToken(userId), user: { id: userId, name, email } });
});

authRouter.post('/login', loginLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.execute('SELECT id, name, email, password_hash FROM users WHERE email = ?', [email]);
  const user = rows[0];
  // Same error for "no such user" and "wrong password", so attackers cannot find valid emails.
  const valid = user && (await bcrypt.compare(password, user.password_hash));
  if (!valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  res.json({ token: issueToken(user.id), user: { id: user.id, name: user.name, email: user.email } });
});
