import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api.js';
import { errorText, formatPaise, when } from '../lib.js';

export function Admin({ me }) {
  return (
    <div className="stack">
      <Users me={me} />
      <div className="grid">
        <AuditLog />
        <Reconcile />
      </div>
    </div>
  );
}

function Users({ me }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const search = useCallback(async (text = '') => {
    try {
      const { data } = await apiRequest(`/admin/users?limit=25${text ? `&q=${encodeURIComponent(text)}` : ''}`);
      setItems(data.items);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);
  useEffect(() => {
    search();
  }, [search]);

  const change = async (user, action) => {
    const reason = window.prompt(`Reason to ${action} ${user.email}'s wallet (kept in the audit log):`);
    if (!reason) return;
    try {
      await apiRequest(`/admin/users/${user.id}/${action}`, { method: 'POST', body: { reason } });
      search(q);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="card">
      <h2>Users</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          search(q);
        }}
      >
        <input placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn">Search</button>
      </form>
      {error && <p className="form-error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>2FA</th>
              <th className="num">Balance</th>
              <th>Wallet</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  <br />
                  <span className="muted">{u.email}</span>
                  {u.locked && <span className="pill declined">locked</span>}
                </td>
                <td>{u.role}</td>
                <td>{u.twoFactorEnabled ? 'on' : '—'}</td>
                <td className="num">{formatPaise(u.wallet.balancePaise)}</td>
                <td>
                  <span className={`pill ${u.wallet.status === 'FROZEN' ? 'declined' : 'paid'}`}>{u.wallet.status.toLowerCase()}</span>
                </td>
                <td>
                  {u.id !== me.user.id && (
                    <button className="btn small" onClick={() => change(u, u.wallet.status === 'FROZEN' ? 'unfreeze' : 'freeze')}>
                      {u.wallet.status === 'FROZEN' ? 'Unfreeze' : 'Freeze'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AuditLog() {
  const [items, setItems] = useState([]);
  const [action, setAction] = useState('');
  useEffect(() => {
    apiRequest(`/admin/audit-logs?limit=30${action ? `&action=${action}` : ''}`).then(({ data }) => setItems(data.items));
  }, [action]);

  return (
    <section className="card">
      <h2>Audit log</h2>
      <select value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">All events</option>
        {['LOGIN_FAILED', 'ACCOUNT_LOCKED', 'REFRESH_TOKEN_REUSED', 'WALLET_FROZEN', 'WALLET_UNFROZEN', 'REFUND_ISSUED', 'GATEWAY_TOPUP_CREDITED', 'WEBHOOK_REJECTED'].map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <ul className="plain">
        {items.map((e) => (
          <li key={e.id}>
            <strong>{e.action}</strong>
            <span className="muted">
              {when(e.createdAt)} · {e.actor?.email ?? 'system'}
              {e.target ? ` → ${e.target.type} ${e.target.id}` : ''}
              {e.metadata?.reason ? ` · "${e.metadata.reason}"` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Reconcile() {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="card">
      <h2>Ledger reconciliation</h2>
      <p className="muted">Checks every wallet against its ledger, every transaction has one debit and one credit, no refund exceeds its payment, and all balances sum to zero.</p>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setReport((await apiRequest('/admin/reconcile')).data);
          setBusy(false);
        }}
      >
        {busy ? 'Checking…' : 'Run reconciliation'}
      </button>
      {report && (
        <p className={report.ok ? 'form-ok' : 'form-error'}>
          {report.ok
            ? 'All checks passed. The books balance.'
            : `Problems: ${report.walletMismatches.length} wallet mismatch(es), ${report.unbalancedTransactions.length} unbalanced transaction(s), ${report.overRefundedTransactions.length} over-refund(s).`}
        </p>
      )}
    </section>
  );
}
