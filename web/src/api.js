// Fetch wrapper.
//
// Sessions: the access token lives only in memory (a variable), never in localStorage, so a script
// injected into the page cannot read a long-lived credential. The refresh token is an httpOnly
// cookie the browser sends only to /api/auth. On page load, and whenever the access token expires,
// we call /api/auth/refresh to get a new one.
//
// Throws ApiError for HTTP errors and NetworkError when the request never got an answer; the UI
// treats those two very differently (see PaymentForm).

let accessToken = null;
let refreshing = null; // one refresh at a time, shared by every caller (single flight)
let onSignedOut = () => {};

export const setAccessToken = (token) => {
  accessToken = token;
};
export const onSessionEnded = (callback) => {
  onSignedOut = callback;
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
    this.requestId = body?.error?.requestId;
  }
}

export class NetworkError extends Error {}

const CLIENT_HEADER = { 'x-payledger-client': 'web' };

/** Exchanges the refresh cookie for a new access token. Returns the session or null. */
export function refreshSession() {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', headers: CLIENT_HEADER, credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) return null;
      const data = await response.json();
      accessToken = data.accessToken;
      return data;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: CLIENT_HEADER, credentials: 'same-origin' }).catch(() => {});
  accessToken = null;
}

async function send(path, { method, body, idempotencyKey }) {
  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  try {
    return await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new NetworkError(
      idempotencyKey
        ? 'Could not reach the server. Your payment may or may not have gone through — retrying is safe.'
        : 'Could not reach the server. Check your connection and try again.',
    );
  }
}

export async function apiRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  let response = await send(path, { method, body, idempotencyKey });
  // Access token expired: refresh once and retry the same request (same idempotency key, so a
  // payment retried here can never run twice).
  if (response.status === 401 && !path.startsWith('/auth/')) {
    const data = await response.clone().json().catch(() => null);
    if (data?.error?.code === 'TOKEN_EXPIRED' && (await refreshSession())) {
      response = await send(path, { method, body, idempotencyKey });
    }
  }
  const data = await response.json().catch(() => null);
  if (response.status === 401 && !path.startsWith('/auth/')) onSignedOut();
  if (!response.ok) throw new ApiError(response.status, data);
  return { data, replayed: response.headers.get('idempotent-replayed') === 'true' };
}

/** Downloads a file (e.g. a statement) with the access token and saves it. */
export async function download(path, filename) {
  let response = await send(path, { method: 'GET' });
  if (response.status === 401 && (await refreshSession())) response = await send(path, { method: 'GET' });
  if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => null));
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
