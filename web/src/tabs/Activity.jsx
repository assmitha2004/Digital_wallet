import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest, NetworkError } from '../api.js';
import { errorText, formatPaise, newKey, when } from '../lib.js';

export function Activity({ version, onChanged, compact = false }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refunding, setRefunding] = useState(null);

  const load = useCallback(
    async (fromCursor) => {
      setLoading(true);
      try {
        const { data } = await apiRequest(`/wallet/activity?limit=${compact ? 5 : 15}${fromCursor ? `&cursor=${fromCursor}` : ''}`);
        setItems((prev) => (fromCursor ? [...prev, ...data.items] : data.items));
        setCursor(compact ? null : data.nextCursor);
      } finally {
        setLoading(false);
      }
    },
    [compact],
  );

  useEffect(() => {
    load(null);
  }, [version, load]);

  return (
    <section className="card">
      <h2>{compact ? 'Recent activity' : 'Activity'}</h2>
      {items.length === 0 && !loading && <p className="muted">No payments yet. Add money to get started.</p>}
      <ul className="activity">
        {items.map((item) => {
          const incoming = item.direction === 'CREDIT';
          const name = item.counterparty?.name;
          const who =
            item.type === 'TOPUP' ? 'Added money' : item.type === 'REFUND' ? (incoming ? `Refund from ${name}` : `Refund to ${name}`) : incoming ? `From ${name}` : `To ${name}`;
          return (
            <li key={`${item.id}-${item.direction}`}>
              <span className={incoming ? 'icon in' : 'icon out'}>{item.type === 'REFUND' ? '↺' : incoming ? '↓' : '↑'}</span>
              <div className="activity-main">
                <strong>{who}</strong>
                <span className="muted">
                  {when(item.createdAt)}
                  {item.note && item.type !== 'TOPUP' ? ` · ${item.note}` : ''}
                  {item.refundedPaise > 0 ? ` · ${formatPaise(item.refundedPaise)} refunded` : ''}
                </span>
                {refunding === item.id && (
                  <RefundForm
                    item={item}
                    onClose={() => setRefunding(null)}
                    onDone={() => {
                      setRefunding(null);
                      onChanged();
                    }}
                  />
                )}
              </div>
              <div className="activity-amount">
                <strong className={incoming ? 'in' : 'out'}>
                  {incoming ? '+' : '−'}
                  {formatPaise(item.amountPaise)}
                </strong>
                <span className="muted">bal {formatPaise(item.balanceAfterPaise)}</span>
                {!compact && item.refundablePaise > 0 && refunding !== item.id && (
                  <button className="link" onClick={() => setRefunding(item.id)}>
                    Refund
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {cursor && (
        <button className="btn ghost wide" disabled={loading} onClick={() => load(cursor)}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      )}
    </section>
  );
}

function RefundForm({ item, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newKey);
  const [status, setStatus] = useState({ kind: 'idle' });

  const submit = async (event) => {
    event.preventDefault();
    setStatus({ kind: 'busy' });
    try {
      const body = { ...(amount && { amount }), ...(reason && { reason }) };
      await apiRequest(`/transactions/${item.id}/refunds`, { method: 'POST', body, idempotencyKey: key });
      onDone();
    } catch (err) {
      if (!(err instanceof NetworkError || (err instanceof ApiError && err.status >= 500))) setKey(newKey());
      setStatus({ kind: 'error', message: errorText(err) });
    }
  };

  return (
    <form className="inline-form" onSubmit={submit}>
      <input inputMode="decimal" placeholder={`Amount (max ${formatPaise(item.refundablePaise)})`} value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input placeholder="Reason (optional)" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <button className="btn primary small" disabled={status.kind === 'busy'}>
          {amount ? 'Refund amount' : 'Refund all'}
        </button>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Cancel
        </button>
      </div>
      {status.kind === 'error' && <p className="form-error">{status.message}</p>}
    </form>
  );
}
