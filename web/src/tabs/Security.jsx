import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api.js';
import { errorText, formatPaise, when } from '../lib.js';

const ACTION_TEXT = {
  USER_REGISTERED: 'Account created',
  LOGIN_SUCCEEDED: 'Logged in',
  LOGIN_FAILED: 'Failed login attempt',
  ACCOUNT_LOCKED: 'Account locked after failed attempts',
  LOGOUT: 'Logged out',
  LOGOUT_ALL: 'Logged out everywhere',
  REFRESH_TOKEN_REUSED: 'Session ended: a copied login token was used',
  TWO_FACTOR_ENABLED: 'Two-step verification turned on',
  TWO_FACTOR_DISABLED: 'Two-step verification turned off',
  REFUND_ISSUED: 'Refund issued',
  WALLET_FROZEN: 'Wallet frozen by support',
  WALLET_UNFROZEN: 'Wallet unfrozen by support',
  GATEWAY_TOPUP_CREDITED: 'Card / UPI top-up credited',
};

export function Security({ me, onChanged, onSignedOutEverywhere }) {
  const [events, setEvents] = useState([]);
  const [sessions, setSessions] = useState([]);

  const load = useCallback(async () => {
    const [ev, se] = await Promise.all([apiRequest('/me/security-events'), apiRequest('/auth/sessions')]);
    setEvents(ev.data.items);
    setSessions(se.data.items);
  }, []);
  useEffect(() => {
    load();
  }, [load, me.user.twoFactorEnabled]);

  return (
    <div className="grid">
      <div className="stack">
        <TwoFactor me={me} onChanged={onChanged} />
        <section className="card">
          <h2>Where you're logged in</h2>
          <ul className="plain">
            {sessions.map((s) => (
              <li key={s.id}>
                <strong>{describeAgent(s.userAgent)}</strong>
                <span className="muted">
                  {s.ip ?? 'unknown IP'} · last active {when(s.lastActiveAt)}
                </span>
              </li>
            ))}
          </ul>
          <button
            className="btn"
            onClick={async () => {
              await apiRequest('/auth/logout-all', { method: 'POST' });
              onSignedOutEverywhere();
            }}
          >
            Log out everywhere
          </button>
          <p className="muted">Ends every session on every device at once, including this one.</p>
        </section>
      </div>
      <section className="card">
        <h2>Recent security activity</h2>
        <ul className="plain">
          {events.map((e) => (
            <li key={e.id}>
              <strong className={e.action.includes('FAILED') || e.action.includes('LOCKED') || e.action.includes('REUSED') ? 'out' : ''}>
                {ACTION_TEXT[e.action] ?? e.action}
              </strong>
              <span className="muted">
                {when(e.createdAt)}
                {e.ip ? ` · ${e.ip}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function describeAgent(agent = '') {
  if (!agent) return 'Unknown device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const os = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'macOS' : /Linux/.test(agent) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function TwoFactor({ me, onChanged }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const start = async () => {
    setError('');
    try {
      const { data } = await apiRequest('/auth/2fa/setup', { method: 'POST' });
      setSetup({ ...data, qr: await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 180 }) });
    } catch (err) {
      setError(errorText(err));
    }
  };
  const submit = async (event, path, body) => {
    event.preventDefault();
    setError('');
    try {
      await apiRequest(path, { method: 'POST', body });
      setSetup(null);
      setCode('');
      setPassword('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (me.user.twoFactorEnabled) {
    return (
      <form className="card" onSubmit={(e) => submit(e, '/auth/2fa/disable', { password, code })}>
        <h2>Two-step verification <span className="pill paid">on</span></h2>
        <p className="muted">
          Asked at login and for payments of {formatPaise(me.settings.stepUpThresholdPaise)} or more.
        </p>
        <details>
          <summary>Turn it off</summary>
          <label>
            Password
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            Authenticator code
            <input required inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button className="btn">Turn off</button>
        </details>
        {error && <p className="form-error">{error}</p>}
      </form>
    );
  }

  return (
    <section className="card">
      <h2>Two-step verification <span className="pill cancelled">off</span></h2>
      <p className="muted">
        Use an authenticator app (Google Authenticator, Microsoft Authenticator, Authy). Needed to send{' '}
        {formatPaise(me.settings.stepUpThresholdPaise)} or more.
      </p>
      {!setup && (
        <button className="btn primary" onClick={start}>
          Set up
        </button>
      )}
      {setup && (
        <form className="stack" onSubmit={(e) => submit(e, '/auth/2fa/enable', { code })}>
          <div className="qr-row">
            <img src={setup.qr} width="180" height="180" alt="QR code for your authenticator app" />
            <div className="muted">
              <p>1. Scan this with your authenticator app.</p>
              <p>
                Or type the key: <code className="secret">{setup.secret.match(/.{1,4}/g).join(' ')}</code>
              </p>
              <p>2. Enter the 6-digit code it shows.</p>
            </div>
          </div>
          <label>
            Code
            <input required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button className="btn primary">Turn on</button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
