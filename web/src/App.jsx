import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest, logout, onSessionEnded, refreshSession, setAccessToken } from './api.js';
import { errorText, formatPaise } from './lib.js';
import { Activity } from './tabs/Activity.jsx';
import { Admin } from './tabs/Admin.jsx';
import { Home } from './tabs/Home.jsx';
import { Requests } from './tabs/Requests.jsx';
import { Security } from './tabs/Security.jsx';
import { Statements } from './tabs/Statements.jsx';

export default function App() {
  const [session, setSession] = useState('loading'); // loading | signed-out | signed-in | error
  const [me, setMe] = useState(null);

  const loadMe = useCallback(async () => {
    try {
      const { data } = await apiRequest('/me');
      setMe(data);
      setSession('signed-in');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setSession('signed-out');
      else setSession('error');
    }
  }, []);

  // On first load there is no access token in memory: try the refresh cookie.
  useEffect(() => {
    onSessionEnded(() => {
      setAccessToken(null);
      setMe(null);
      setSession('signed-out');
    });
    refreshSession().then((s) => (s ? loadMe() : setSession('signed-out')));
  }, [loadMe]);

  const signOut = async () => {
    await logout();
    setMe(null);
    setSession('signed-out');
  };

  if (session === 'loading') return <div className="center-note">Loading…</div>;
  if (session === 'signed-out') return <AuthScreen onSignedIn={loadMe} />;
  if (session === 'error')
    return (
      <div className="center-note">
        <p>Could not reach PayLedger.</p>
        <button className="btn" onClick={() => loadMe()}>
          Try again
        </button>
      </div>
    );
  return <Dashboard me={me} onRefresh={loadMe} onSignOut={signOut} onSignedOutEverywhere={() => setSession('signed-out')} />;
}

function AuthScreen({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', otp: '' });
  const [needOtp, setNeedOtp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body =
        mode === 'login'
          ? { email: form.email, password: form.password, ...(needOtp && form.otp && { otp: form.otp }) }
          : { name: form.name, email: form.email, password: form.password };
      const { data } = await apiRequest(`/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body });
      setAccessToken(data.accessToken);
      onSignedIn();
    } catch (err) {
      if (err.code === 'OTP_REQUIRED') {
        setNeedOtp(true);
        setError('');
      } else {
        if (['INVALID_OTP', 'OTP_ALREADY_USED'].includes(err.code)) setForm((f) => ({ ...f, otp: '' }));
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const field = (name) => ({ value: form[name], onChange: (e) => setForm({ ...form, [name]: e.target.value }) });
  const switchMode = (tab) => {
    setMode(tab);
    setNeedOtp(false);
    setError('');
  };

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
          A digital wallet built on a double-entry ledger. Payments are locked, idempotent and audited, so money is never lost,
          duplicated or double-spent.
        </p>
        <ul className="auth-points">
          <li>Each payment writes a matching debit and credit</li>
          <li>Retrying a payment never charges twice</li>
          <li>Two-step verification for logins and large payments</li>
          <li>Refunds, payment requests and downloadable statements</li>
        </ul>
        <p className="muted">
          Demo login: <code>demo@payledger.dev</code> / <code>demo12345</code>
        </p>
      </section>
      <form className="card auth-card" onSubmit={submit}>
        <div className="tabs" role="tablist">
          {['login', 'register'].map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={mode === tab} className={mode === tab ? 'tab active' : 'tab'} onClick={() => switchMode(tab)}>
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
          <input
            required
            type="password"
            minLength={mode === 'register' ? 8 : 1}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            {...field('password')}
          />
        </label>
        {needOtp && (
          <label>
            Code from your authenticator app
            <input required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="\d{6}" {...field('otp')} />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="btn primary wide" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? (needOtp ? 'Verify and log in' : 'Log in') : 'Create account'}
        </button>
      </form>
    </main>
  );
}

const TABS = [
  ['home', 'Home'],
  ['activity', 'Activity'],
  ['requests', 'Requests'],
  ['statements', 'Statements'],
  ['security', 'Security'],
];

function Dashboard({ me, onRefresh, onSignOut, onSignedOutEverywhere }) {
  const [tab, setTab] = useState('home');
  const [version, setVersion] = useState(0);
  const changed = () => {
    onRefresh();
    setVersion((v) => v + 1);
  };
  const tabs = me.user.role === 'ADMIN' ? [...TABS, ['admin', 'Admin']] : TABS;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">₹</span> PayLedger
        </div>
        <div className="topbar-user">
          <span>{me.user.email}</span>
          <button className="btn ghost small" onClick={onSignOut}>
            Log out
          </button>
        </div>
      </header>

      <section className="balance card dark">
        <div>
          <p className="eyebrow">Available balance</p>
          <p className="balance-amount">{formatPaise(me.wallet.balancePaise)}</p>
          <p className="muted-light">
            Hi {me.user.name.split(' ')[0]} — your balance is checked against the ledger on every load.
            {me.wallet.status === 'FROZEN' && <strong className="frozen"> Your wallet is frozen. Contact support.</strong>}
          </p>
        </div>
        <LedgerCheck version={version} />
      </section>

      <nav className="nav" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'nav-item active' : 'nav-item'} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'home' && (
        <>
          <Home me={me} onPaid={changed} goTo={setTab} />
          <Activity version={version} onChanged={changed} compact />
        </>
      )}
      {tab === 'activity' && <Activity version={version} onChanged={changed} />}
      {tab === 'requests' && <Requests me={me} version={version} onChanged={changed} />}
      {tab === 'statements' && <Statements />}
      {tab === 'security' && <Security me={me} onChanged={changed} onSignedOutEverywhere={onSignedOutEverywhere} />}
      {tab === 'admin' && me.user.role === 'ADMIN' && <Admin me={me} />}
    </div>
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
