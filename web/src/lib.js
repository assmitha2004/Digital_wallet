const rupee = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
export const formatPaise = (paise) => rupee.format(paise / 100);
export const newKey = () => crypto.randomUUID();
export const when = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** Readable text for an API error, including field-level validation details. */
export const errorText = (err) => err?.details?.map((d) => d.message).join(' ') || err?.message || 'Something went wrong.';

/** Error codes that mean "ask the user for their authenticator code". */
export const OTP_CODES = new Set(['OTP_REQUIRED', 'INVALID_OTP', 'OTP_ALREADY_USED']);
