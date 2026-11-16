import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api.js';
import { errorText, formatPaise, newKey, OTP_CODES, when } from '../lib.js';
import { PaymentForm } from '../PaymentForm.jsx';

export function Requests({ me, version, onChanged }) {
  const [direction, setDirection] = useState('incoming');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await apiRequest(`/payment-requests?direction=${direction}`);
      setItems(data.items);
    } catch (err) {
      setError(errorText(err));
    }
  }, [direction]);

  useEffect(() => {
    load();
  }, [load, version]);

  return (
    <div className="grid">
      <PaymentForm
        title="Request money"
        subtitle="They get a request they can pay with one click."
        submitLabel="Send request"
        fields={[
          { name: 'fromEmail', label: 'Who should pay you?', type: 'email', placeholder: 'friend@example.com' },
          { name: 'amount', label: 'Amount (₹)', inputMode: 'decimal', placeholder: '300.00' },
          { name: 'note', label: 'What for? (optional)', optional: true, placeholder: 'Movie tickets', maxLength: 140 },
        ]}
        path="/payment-requests"
        success={(data) => `Asked ${data.request.payer.name} for ${formatPaise(data.request.amountPaise)}.`}
        onDone={() => {
          setDirection('outgoing');
          load();
        }}
      />
      <section className="card">
        <div className="tabs" role="tablist">
          {['incoming', 'outgoing'].map((d) => (
            <button key={d} role="tab" aria-selected={direction === d} className={direction === d ? 'tab active' : 'tab'} onClick={() => setDirection(d)}>
              {d === 'incoming' ? 'Asked of you' : 'You asked'}
            </button>
          ))}
        </div>
        {error && <p className="form-error">{error}</p>}
        {items.length === 0 && <p className="muted">Nothing here yet.</p>}
        <ul className="activity">
          {items.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              direction={direction}
              twoFactor={me.user.twoFactorEnabled && r.amountPaise >= me.settings.stepUpThresholdPaise}
              onChanged={() => {
                load();
                onChanged();
              }}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function RequestRow({ request, direction, twoFactor, onChanged }) {
  const [key, setKey] = useState(newKey);
  const [otp, setOtp] = useState('');
  const [askOtp, setAskOtp] = useState(twoFactor);
  const [status, setStatus] = useState({ kind: 'idle' });

  const act = async (action) => {
    setStatus({ kind: 'busy' });
    try {
      if (action === 'pay') {
        await apiRequest(`/payment-requests/${request.id}/pay`, { method: 'POST', body: otp ? { otp } : {}, idempotencyKey: key });
      } else {
        await apiRequest(`/payment-requests/${request.id}/${action}`, { method: 'POST' });
      }
      onChanged();
    } catch (err) {
      if (err.status && err.status < 500) setKey(newKey());
      if (OTP_CODES.has(err.code)) setAskOtp(true);
      setStatus({ kind: 'error', message: errorText(err) });
    }
  };

  const pending = request.status === 'PENDING';
  return (
    <li>
      <span className={`pill ${request.status.toLowerCase()}`}>{request.status.toLowerCase()}</span>
      <div className="activity-main">
        <strong>
          {direction === 'incoming' ? `${request.counterparty.name} asks` : `You asked ${request.counterparty.name}`} {formatPaise(request.amountPaise)}
        </strong>
        <span className="muted">
          {when(request.createdAt)}
          {request.note ? ` · ${request.note}` : ''}
        </span>
        {status.kind === 'error' && <span className="form-error">{status.message}</span>}
      </div>
      {pending && (
        <div className="row">
          {direction === 'incoming' && askOtp && (
            <input className="otp" inputMode="numeric" maxLength={6} placeholder="Code" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} />
          )}
          {direction === 'incoming' ? (
            <>
              <button className="btn primary small" disabled={status.kind === 'busy'} onClick={() => act('pay')}>
                Pay
              </button>
              <button className="btn ghost small" disabled={status.kind === 'busy'} onClick={() => act('decline')}>
                Decline
              </button>
            </>
          ) : (
            <button className="btn ghost small" disabled={status.kind === 'busy'} onClick={() => act('cancel')}>
              Cancel
            </button>
          )}
        </div>
      )}
    </li>
  );
}
