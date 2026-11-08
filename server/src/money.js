// Money helpers. Amounts travel as strings in rupees ("250.50") and are stored as integer
// paise (25050). We never do floating-point maths on money: 0.1 + 0.2 !== 0.3 in JavaScript.

const AMOUNT_PATTERN = /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/;

/** "250.5" -> 25050. Returns null for anything that is not a valid positive amount. */
export function rupeesToPaise(input) {
  const text = typeof input === 'number' ? String(input) : input;
  if (typeof text !== 'string' || !AMOUNT_PATTERN.test(text.trim())) return null;
  const [whole, fraction = ''] = text.trim().split('.');
  const paise = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return paise > 0 && Number.isSafeInteger(paise) ? paise : null;
}

/** 25050 -> "250.50" */
export function formatPaise(paise) {
  const sign = paise < 0 ? '-' : '';
  const absolute = Math.abs(paise);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** Midnight today in India (UTC+05:30), as a UTC Date — used for the daily transfer limit. */
export function startOfTodayIST(now = new Date()) {
  const istOffsetMs = 330 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffsetMs);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - istOffsetMs);
}

const inrFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
/** 10000000 -> "₹1,00,000.00" — for human-readable messages only (display, never maths). */
export const displayInr = (paise) => inrFormatter.format(paise / 100);
