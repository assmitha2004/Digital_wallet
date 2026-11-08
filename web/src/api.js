// Small fetch wrapper. Throws ApiError for HTTP errors and NetworkError when the request
// never got an answer — the UI treats those two very differently (see PaymentForm).

const TOKEN_KEY = 'payledger.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode): the session just won't survive a reload */
  }
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

export class NetworkError extends Error {}

export async function apiRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  let response;
  try {
    response = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new NetworkError('Could not reach the server. Your payment may or may not have gone through — retrying is safe.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data);
  return { data, replayed: response.headers.get('idempotent-replayed') === 'true' };
}
