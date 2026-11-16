// Account statements for a date range, as CSV or PDF.
import PDFDocument from 'pdfkit';
import { pool } from './db.js';
import { unprocessable } from './errors.js';
import { formatPaise } from './money.js';

const IST_OFFSET_MS = 330 * 60 * 1000;
const MAX_DAYS = 366;
const MAX_ROWS = 5000;

/** "2026-11-01" (a day in India) -> the UTC instant that day starts. */
const istDayStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
const istDateTime = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);

const describe = (row) => {
  if (row.type === 'TOPUP') return 'Added money';
  if (row.type === 'REFUND') return row.direction === 'CREDIT' ? `Refund from ${row.counterparty_name}` : `Refund to ${row.counterparty_name}`;
  return row.direction === 'CREDIT' ? `From ${row.counterparty_name}` : `To ${row.counterparty_name}`;
};

export async function buildStatement(walletId, { from, to }) {
  const start = istDayStart(from);
  const end = new Date(istDayStart(to).getTime() + 24 * 60 * 60 * 1000); // end of the "to" day
  if (end <= start) throw unprocessable('INVALID_RANGE', '"from" must be on or before "to".');
  if ((end - start) / 86_400_000 > MAX_DAYS) throw unprocessable('RANGE_TOO_LONG', `A statement can cover at most ${MAX_DAYS} days.`);

  // Opening balance = balance after the last entry before the range (0 if none).
  const [[opening]] = await pool.execute(
    'SELECT balance_after_paise FROM ledger_entries WHERE wallet_id = ? AND created_at < ? ORDER BY id DESC LIMIT 1',
    [walletId, start],
  );
  const [rows] = await pool.execute(
    `SELECT le.direction, le.amount_paise, le.balance_after_paise, le.created_at, t.public_id, t.type, t.note, cu.name AS counterparty_name
       FROM ledger_entries le
       JOIN transactions t ON t.id = le.transaction_id
       JOIN wallets cw ON cw.id = IF(le.direction = 'DEBIT', t.to_wallet_id, t.from_wallet_id)
       LEFT JOIN users cu ON cu.id = cw.user_id
      WHERE le.wallet_id = ? AND le.created_at >= ? AND le.created_at < ?
      ORDER BY le.id ASC LIMIT ${MAX_ROWS + 1}`,
    [walletId, start, end],
  );
  if (rows.length > MAX_ROWS) throw unprocessable('RANGE_TOO_BUSY', 'Too many entries for one statement. Choose a shorter range.');

  const openingPaise = opening?.balance_after_paise ?? 0;
  const entries = rows.map((row) => ({
    date: istDateTime(row.created_at),
    description: describe(row),
    note: row.type === 'TOPUP' ? '' : (row.note ?? ''),
    reference: row.public_id,
    debitPaise: row.direction === 'DEBIT' ? row.amount_paise : 0,
    creditPaise: row.direction === 'CREDIT' ? row.amount_paise : 0,
    balancePaise: row.balance_after_paise,
  }));
  return {
    from,
    to,
    openingPaise,
    closingPaise: entries.at(-1)?.balancePaise ?? openingPaise,
    totalInPaise: entries.reduce((sum, e) => sum + e.creditPaise, 0),
    totalOutPaise: entries.reduce((sum, e) => sum + e.debitPaise, 0),
    entries,
  };
}

/**
 * CSV with formula-injection protection: a note like "=HYPERLINK(...)" would run as a formula
 * when the file is opened in Excel, so cells starting with = + - @ are prefixed with an apostrophe.
 */
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function statementCsv(statement) {
  const lines = [
    ['Date (IST)', 'Description', 'Note', 'Reference', 'Debit (INR)', 'Credit (INR)', 'Balance (INR)'],
    ['', 'Opening balance', '', '', '', '', formatPaise(statement.openingPaise)],
    ...statement.entries.map((e) => [
      e.date,
      e.description,
      e.note,
      e.reference,
      e.debitPaise ? formatPaise(e.debitPaise) : '',
      e.creditPaise ? formatPaise(e.creditPaise) : '',
      formatPaise(e.balancePaise),
    ]),
    ['', 'Closing balance', '', '', formatPaise(statement.totalOutPaise), formatPaise(statement.totalInPaise), formatPaise(statement.closingPaise)],
  ];
  return `${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Streams a PDF statement into `stream` (the HTTP response). Built-in fonts have no ₹ sign, so amounts use "Rs.". */
export function writeStatementPdf(statement, { name, email }, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `PayLedger statement ${statement.from} to ${statement.to}` } });
  doc.pipe(stream);
  const rs = (paise) => `Rs. ${formatPaise(paise)}`;

  doc.font('Helvetica-Bold').fontSize(18).text('PayLedger', { continued: true }).font('Helvetica').fontSize(12).text('   Account statement');
  doc.moveDown(0.3).fontSize(10).fillColor('#444').text(`${name} <${email}>`);
  doc.text(`Period: ${statement.from} to ${statement.to} (India time)`);
  doc.moveDown(0.6).fillColor('#000');
  doc.text(`Opening balance: ${rs(statement.openingPaise)}     Money in: ${rs(statement.totalInPaise)}     Money out: ${rs(statement.totalOutPaise)}     Closing balance: ${rs(statement.closingPaise)}`);
  doc.moveDown(0.8);

  const cols = [
    { title: 'Date (IST)', x: 40, width: 85 },
    { title: 'Description', x: 128, width: 170 },
    { title: 'Debit', x: 300, width: 80, align: 'right' },
    { title: 'Credit', x: 383, width: 80, align: 'right' },
    { title: 'Balance', x: 466, width: 89, align: 'right' },
  ];
  const row = (values, bold = false) => {
    if (doc.y > 770) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    let height = 0;
    cols.forEach((col, i) => {
      doc.text(values[i], col.x, y, { width: col.width, align: col.align ?? 'left' });
      height = Math.max(height, doc.y - y);
    });
    doc.y = y + height + 4;
    doc.x = 40;
  };
  row(cols.map((c) => c.title), true);
  doc.moveTo(40, doc.y - 2).lineTo(555, doc.y - 2).strokeColor('#999').stroke();
  for (const e of statement.entries) {
    row([
      e.date,
      e.note ? `${e.description} - ${e.note}` : e.description,
      e.debitPaise ? rs(e.debitPaise) : '',
      e.creditPaise ? rs(e.creditPaise) : '',
      rs(e.balancePaise),
    ]);
  }
  if (statement.entries.length === 0) row(['', 'No payments in this period.', '', '', '']);
  doc.moveDown(1).fontSize(7.5).fillColor('#666').text(
    'Every entry is one side of a double-entry ledger record. References are transaction ids you can quote to support.',
    40,
  );
  doc.end();
}
