import { AppError } from './errors.js';
import { verifyTotp } from './totp.js';

/**
 * Checks a 6-digit code for a user and marks its time step as used, so the same code cannot be
 * accepted twice (replay). The "mark as used" is one conditional UPDATE: if two requests send the
 * same code at once, only one UPDATE matches a row.
 *
 * Throws 401 INVALID_OTP or OTP_ALREADY_USED. Pass the transaction's connection when the code
 * protects a payment, so the code is only spent if the payment's transaction commits.
 */
export async function consumeOtp(db, userId, code, { secret } = {}) {
  let totpSecret = secret;
  if (!totpSecret) {
    const [[user]] = await db.execute('SELECT totp_secret FROM users WHERE id = ?', [userId]);
    totpSecret = user?.totp_secret;
  }
  const step = verifyTotp(totpSecret, code);
  if (step === null) throw new AppError(401, 'INVALID_OTP', 'That code is not correct. Check your authenticator app.');
  const [result] = await db.execute(
    'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
    [step, userId, step],
  );
  if (result.affectedRows === 0) {
    throw new AppError(401, 'OTP_ALREADY_USED', 'That code was already used. Wait for the next code.');
  }
}
