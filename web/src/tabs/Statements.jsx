import { useState } from 'react';
import { apiRequest, download } from '../api.js';
import { errorText, formatPaise } from '../lib.js';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const istMonthStart = () => `${istToday().slice(0, 8)}01`;

export function Statements() {
  const [from, setFrom] = useState(istMonthStart);
  const [to, setTo] = useState(istToday);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = `from=${from}&to=${to}`;
  const run = async (work) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card narrow">
      <h2>Statement</h2>
      <p className="muted">Dates are in India time. Up to one year per statement.</p>
      <div className="row">
        <label>
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => run(async () => setSummary((await apiRequest(`/wallet/statement?${query}&format=json`)).data))}>
          Preview totals
        </button>
        <button className="btn primary" disabled={busy} onClick={() => run(() => download(`/wallet/statement?${query}&format=pdf`, `payledger-statement-${from}-to-${to}.pdf`))}>
          Download PDF
        </button>
        <button className="btn" disabled={busy} onClick={() => run(() => download(`/wallet/statement?${query}&format=csv`, `payledger-statement-${from}-to-${to}.csv`))}>
          Download CSV
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      {summary && (
        <dl className="summary">
          <div><dt>Opening</dt><dd>{formatPaise(summary.openingPaise)}</dd></div>
          <div><dt>Money in</dt><dd className="in">+{formatPaise(summary.totalInPaise)}</dd></div>
          <div><dt>Money out</dt><dd className="out">−{formatPaise(summary.totalOutPaise)}</dd></div>
          <div><dt>Closing</dt><dd>{formatPaise(summary.closingPaise)}</dd></div>
          <div><dt>Entries</dt><dd>{summary.entries.length}</dd></div>
        </dl>
      )}
    </section>
  );
}
