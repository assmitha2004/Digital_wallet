import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest, getToken, NetworkError, setToken } from './api.js';

const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const formatPaise = (paise) => rupee.format(paise / 100);
const newKey = () => crypto.randomUUID();

export default function App() {
  const [session, setSession] = useState(() => (getToken() ? 'loading' : 'signed-out'));
  const [me, setMe] = useState(null);

  const loadMe = useCallback(async () => {
    try {
      const { data } = await apiRequest('/me');
      setMe(data);
      setSession('signed-in');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setToken(null);
        setSession('signed-out');
      } else {
        setSession('error');
      }
    }
  }, []);

  useEffect(() => {
    if (session === 'loading') loadMe();
  }, [session, loadMe]);

  const signOut = () => {
    setToken(null);
    setMe(null);
    setSession('signed-out');
  };

  if (session === 'signed-out') return <AuthScreen onSignedIn={() => setSession('loading')} />;
  if (session === 'error')
    return (
      <div className="center-note">
        <p>Could not reach PayLedger.</p>
        <button className="btn" onClick={() => setSession('loading')}>Try again</button>
      </div>
    );
  if (!me) return <div className="center-note">Loading…</div>;
  return <Dashboard me={me} onRefresh={loadMe} onSignOut={signOut} />;
}

function AuthScreen({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = mode === 'login' ? { email: form.email, password: form.password } : form;
      const { data } = await apiRequest(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body });
      setToken(data.token);
      onSignedIn();
    } catch (err) {
      setError(err.details?.map((d) => `${d.field}: ${d.message}`).join(' · ') || err.message);
    } finally {
      setBusy(false);
    }
  };

  const field = (name) => ({ value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }) });

  return (
    <main className="auth">
      <section className="auth-intro">
        <div className="brand">
          <span className="brand-mark">₹</span> PayLedger
        </div>
        <h1>
          Every rupee,
          <br />
          accounted for.
        </h1>
        <p>
          A digital wallet built on a double-entry ledger. Payments are locked, idempotent and audited, so money is never
          lost, duplicated or double-spent.
        </p>
        <ul className="auth-points">
          <li>Each payment writes a matching debit and credit</li>
          <li>Retrying a payment never charges twice</li>
          <li>Simultaneous payments cannot overdraw a wallet</li>
        </ul>
      </section>
      <form className="card auth-card" onSubmit={submit}>
        <div className="tabs" role="tablist">
          {['login', 'register'].map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={mode === tab} className={mode === tab ? 'tab active' : 'tab'} onClick={() => setMode(tab)}>
              {tab === 'login' ? 'Log in' : 'Create account'}
            </button>
          ))}
        </div>
        {mode === 'register' && (
          <label>
            Name
            <input required minLength={2} autoComplete="name" {...field('name')} />
          </label>
        )}
        <label>
          Email
          <input required type="email" autoComplete="email" {...field('email')} />
        </label>
        <label>
          Password
          <input required type="password" minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} {...field('password')} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
    </main>
  );
}

function Dashboard({ me, onRefresh, onSignOut }) {
  const [activityVersion, setActivityVersion] = useState(0);
  const afterPayment = () => {
    onRefresh();
    setActivityVersion((v) => v + 1);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">₹</span> PayLedger
        </div>
        <div className="topbar-user">
          <span>{me.user.email}</span>
          <button className="btn ghost small" onClick={onSignOut}>Log out</button>
        </div>
      </header>

      <section className="balance card dark">
        <div>
          <p className="eyebrow">Available balance</p>
          <p className="balance-amount">{formatPaise(me.wallet.balancePaise)}</p>
          <p className="muted-light">Hi {me.user.name.split(' ')[0]} — your balance is checked against the ledger on every load.</p>
        </div>
        <LedgerCheck version={activityVersion} />
      </section>

      <div className="grid">
        <PaymentForm
          title="Add money"
          subtitle="Simulated payment gateway · max ₹50,000"
          submitLabel="Add money"
          fields={[{ name: 'amount', label: 'Amount (₹)', inputMode: 'decimal', placeholder: '500.00' }]}
          path="/wallet/topups"
          success={(data) => `Added ${formatPaise(data.transaction.amountPaise)}.`}
          onDone={afterPayment}
        />
        <PaymentForm
          title="Send money"
          subtitle="To any PayLedger user by email · max ₹1,00,000"
          submitLabel="Send"
          fields={[
            { name: 'toEmail', label: 'Recipient email', type: 'email', placeholder: 'friend@example.com' },
            { name: 'amount', label: 'Amount (₹)', inputMode: 'decimal', placeholder: '250.00' },
            { name: 'note', label: 'Note (optional)', optional: true, placeholder: 'Dinner' },
          ]}
          path="/transfers"
          success={(data) => `Sent ${formatPaise(data.transaction.amountPaise)} to ${data.transaction.to.name}.`}
          onDone={afterPayment}
        />
      </div>

      <Activity version={activityVersion} />
    </div>
  );
}

/**
 * One idempotency key per payment attempt.
 *  - Server answered (success OR a business error like insufficient funds): make a new key.
 *  - No answer (network error / 5xx): KEEP the key, so pressing "Retry" can never pay twice.
 */
function PaymentForm({ title, subtitle, submitLabel, fields, path, success, onDone }) {
  const empty = Object.fromEntries(fields.map((f) => [f.name, '']));
  const [values, setValues] = useState(empty);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [status, setStatus] = useState({ kind: 'idle' });

  const submit = async (event) => {
    event.preventDefault();
    setStatus({ kind: 'busy' });
    const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
    try {
      const { data, replayed } = await apiRequest(path, { method: 'POST', body, idempotencyKey });
      setStatus({ kind: 'ok', message: success(data) + (replayed ? ' (already processed — not charged again)' : '') });
      setValues(empty);
      setIdempotencyKey(newKey());
      onDone();
    } catch (err) {
      const keepKey = err instanceof NetworkError || (err instanceof ApiError && err.status >= 500);
      if (!keepKey) setIdempotencyKey(newKey());
      setStatus({ kind: 'error', retry: keepKey, message: err.details?.map((d) => d.message).join(' ') || err.message });
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
      <p className="muted">{subtitle}</p>
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          <input
            required={!f.optional}
            type={f.type ?? 'text'}
            inputMode={f.inputMode}
            placeholder={f.placeholder}
            maxLength={f.name === 'note' ? 140 : undefined}
            value={values[f.name]}
            onChange={edit(f.name)}
          />
        </label>
      ))}
      {status.kind === 'ok' && <p className="form-ok">{status.message}</p>}
      {status.kind === 'error' && <p className="form-error">{status.message}</p>}
      <button className="btn primary wide" disabled={status.kind === 'busy'}>
        {status.kind === 'busy' ? 'Processing…' : status.kind === 'error' && status.retry ? 'Retry safely' : submitLabel}
      </button>
      <p className="key-hint" title="Sent as the Idempotency-Key header">
        Idempotency key <code>{idempotencyKey.slice(0, 8)}…</code>
      </p>
    </form>
  );
}

function LedgerCheck({ version }) {
  const [check, setCheck] = useState(null);
  useEffect(() => {
    apiRequest('/wallet/verify')
      .then(({ data }) => setCheck(data))
      .catch(() => setCheck(null));
  }, [version]);
  if (!check) return null;
  return (
    <div className={check.matches ? 'ledger-check ok' : 'ledger-check bad'}>
      <span className="dot" />
      <div>
        <strong>{check.matches ? 'Ledger verified' : 'Ledger mismatch'}</strong>
        <span>
          {check.entries} entries sum to {formatPaise(check.ledgerPaise)}
        </span>
      </div>
    </div>
  );
}

function Activity({ version }) {
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (fromCursor) => {
    setLoading(true);
    try {
      const { data } = await apiRequest(`/wallet/activity?limit=10${fromCursor ? `&cursor=${fromCursor}` : ''}`);
      setItems((prev) => (fromCursor ? [...prev, ...data.items] : data.items));
      setCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [version, load]);

  return (
    <section className="card">
      <h2>Activity</h2>
      {items.length === 0 && !loading && <p className="muted">No payments yet. Add money to get started.</p>}
      <ul className="activity">
        {items.map((item) => {
          const incoming = item.direction === 'CREDIT';
          const who = item.type === 'TOPUP' ? 'Added money' : incoming ? `From ${item.counterparty?.name}` : `To ${item.counterparty?.name}`;
          return (
            <li key={`${item.id}-${item.direction}`}>
              <span className={incoming ? 'icon in' : 'icon out'}>{incoming ? '↓' : '↑'}</span>
              <div className="activity-main">
                <strong>{who}</strong>
                <span className="muted">
                  {new Date(item.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  {item.note && item.type === 'TRANSFER' ? ` · ${item.note}` : ''}
                </span>
              </div>
              <div className="activity-amount">
                <strong className={incoming ? 'in' : 'out'}>
                  {incoming ? '+' : '−'}
                  {formatPaise(item.amountPaise)}
                </strong>
                <span className="muted">bal {formatPaise(item.balanceAfterPaise)}</span>
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
