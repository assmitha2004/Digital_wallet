import { useState } from 'react';
import { ApiError, apiRequest, NetworkError } from './api.js';
import { errorText, newKey, OTP_CODES } from './lib.js';

/**
 * A form that moves money, with safe retries.
 *
 * One idempotency key per payment attempt:
 *  - Server answered (success OR a business error like insufficient funds): make a new key.
 *  - No answer (network error / 5xx): KEEP the key, so pressing "Retry" can never pay twice.
 *
 * Two-step verification: if the payment needs a code (always, at or above the threshold), a code
 * field appears. The code is not part of the idempotency hash on the server, so retrying with a
 * fresh code is still the same payment.
 */
export function PaymentForm({ title, subtitle, submitLabel, fields, path, success, onDone, needsOtp = () => false, onNeedTwoFactor, children }) {
  const empty = Object.fromEntries(fields.map((f) => [f.name, '']));
  const [values, setValues] = useState(empty);
  const [otp, setOtp] = useState('');
  const [askOtp, setAskOtp] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [status, setStatus] = useState({ kind: 'idle' });

  const showOtp = askOtp || needsOtp(values);

  const submit = async (event) => {
    event.preventDefault();
    setStatus({ kind: 'busy' });
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
    if (showOtp && otp) body.otp = otp;
    try {
      const { data, replayed } = await apiRequest(path, { method: 'POST', body, idempotencyKey });
      setStatus({ kind: 'ok', message: success(data) + (replayed ? ' (already processed — not charged again)' : '') });
      setValues(empty);
      setOtp('');
      setAskOtp(false);
      setIdempotencyKey(newKey());
      onDone?.(data);
    } catch (err) {
      const keepKey = err instanceof NetworkError || (err instanceof ApiError && err.status >= 500);
      if (!keepKey) setIdempotencyKey(newKey());
      if (OTP_CODES.has(err.code)) {
        setAskOtp(true);
        setOtp('');
      }
      setStatus({ kind: 'error', retry: keepKey, code: err.code, message: errorText(err) });
    }
  };

  const edit = (name) => (e) => {
    setValues({ ...values, [name]: e.target.value });
    // Changing the payment after a failed attempt makes it a NEW payment, so it needs a new key.
    if (status.kind === 'error' && status.retry) setIdempotencyKey(newKey());
    if (status.kind !== 'busy') setStatus({ kind: 'idle' });
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>{title}</h2>
      {subtitle && <p className="muted">{subtitle}</p>}
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          <input
            required={!f.optional}
            type={f.type ?? 'text'}
            inputMode={f.inputMode}
            placeholder={f.placeholder}
            maxLength={f.maxLength}
            value={values[f.name]}
            onChange={edit(f.name)}
          />
        </label>
      ))}
      {showOtp && (
        <label>
          Authenticator code
          <input
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          />
        </label>
      )}
      {children}
      {status.kind === 'ok' && <p className="form-ok">{status.message}</p>}
      {status.kind === 'error' && (
        <p className="form-error">
          {status.message}{' '}
          {status.code === 'TWO_FACTOR_REQUIRED' && onNeedTwoFactor && (
            <button type="button" className="link" onClick={onNeedTwoFactor}>
              Turn it on
            </button>
          )}
        </p>
      )}
      <button className="btn primary wide" disabled={status.kind === 'busy'}>
        {status.kind === 'busy' ? 'Processing…' : status.kind === 'error' && status.retry ? 'Retry safely' : submitLabel}
      </button>
      <p className="key-hint" title="Sent as the Idempotency-Key header">
        Idempotency key <code>{idempotencyKey.slice(0, 8)}…</code>
      </p>
    </form>
  );
}
