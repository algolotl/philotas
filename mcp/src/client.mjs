// SPDX-License-Identifier: Apache-2.0
// Read-only HTTP client for the Philotas API. Wraps fetch with a base URL taken
// from PHILOTAS_URL, a configurable timeout, and typed errors so callers can
// tell an HTTP failure from a timeout from a misconfigured base URL.

const DEFAULT_TIMEOUT_MS = 10_000;

export class PhilotasApiError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message);
    this.name = 'PhilotasApiError';
    if (status != null) this.status = status;
    if (url != null) this.url = url;
    if (cause != null) this.cause = cause;
  }
}

export class PhilotasHttpError extends PhilotasApiError {
  constructor(status, url, body) {
    super('HTTP ' + status + ' from ' + url, { status, url, cause: body });
    this.name = 'PhilotasHttpError';
    this.body = body;
  }
}

export class PhilotasTimeoutError extends PhilotasApiError {
  constructor(url, timeoutMs) {
    super('request to ' + url + ' timed out after ' + timeoutMs + 'ms', { url });
    this.name = 'PhilotasTimeoutError';
  }
}

export function createClient(options = {}) {
  const baseUrl = options.baseUrl ?? process.env.PHILOTAS_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const guest = options.guest ?? process.env.PHILOTAS_GUEST === '1';
  const authToken = options.token ?? process.env.PHILOTAS_TOKEN;
  const username = options.username ?? process.env.PHILOTAS_USER;
  const password = options.password ?? process.env.PHILOTAS_PASSWORD;
  let sessionCookie = null;
  let sessionPromise = null;

  async function ensureSession() {
    if (!authToken && !(username && password) && !guest) return;
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      if (authToken) {
        sessionCookie = 'parallax_session=' + authToken;
        return;
      }
      if (guest && !(username && password)) {
        const guestUrl = new URL('/api/auth/guest', baseUrl);
        let res;
        try {
          res = await fetchImpl(guestUrl, {
            method: 'POST',
            headers: { Accept: 'application/json' },
          });
        } catch (err) {
          throw new PhilotasApiError('guest session request to ' + guestUrl + ' failed: ' + (err && err.message ? err.message : err), { url: guestUrl.toString(), cause: err });
        }
        if (!res.ok) throw new PhilotasHttpError(res.status, guestUrl.toString(), 'guest session unavailable');
        const setCookie = res.headers.get('set-cookie') || '';
        const match = setCookie.match(/parallax_session=([^;]+)/);
        if (!match) throw new PhilotasApiError('guest session succeeded but no session cookie was set', { url: guestUrl.toString() });
        sessionCookie = 'parallax_session=' + match[1];
        return;
      }
      const loginUrl = new URL('/api/auth/login', baseUrl);
      let res;
      try {
        res = await fetchImpl(loginUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username, password }),
        });
      } catch (err) {
        throw new PhilotasApiError('login request to ' + loginUrl + ' failed: ' + (err && err.message ? err.message : err), { url: loginUrl.toString(), cause: err });
      }
      if (!res.ok) {
        let body;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        const reason = body && body.error ? body.error : 'login failed';
        throw new PhilotasHttpError(res.status, loginUrl.toString(), body || reason);
      }
      const setCookie = res.headers.get('set-cookie') || '';
      const match = setCookie.match(/parallax_session=([^;]+)/);
      if (!match) throw new PhilotasApiError('login succeeded but no session cookie was set', { url: loginUrl.toString() });
      sessionCookie = 'parallax_session=' + match[1];
    })();
    return sessionPromise;
  }

  async function get(path, { params } = {}) {
    if (!baseUrl) {
      throw new PhilotasApiError('PHILOTAS_URL is not set');
    }
    const url = new URL(path, baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }
    await ensureSession();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(sessionCookie ? { Cookie: sessionCookie } : {}) },
      });
      if (!res.ok) {
        let body;
        try {
          body = await res.json();
        } catch {
          body = await res.text().catch(() => undefined);
        }
        throw new PhilotasHttpError(res.status, url.toString(), body);
      }
      return await res.json();
    } catch (err) {
      if (err instanceof PhilotasApiError) throw err;
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new PhilotasTimeoutError(url.toString(), timeoutMs);
      }
      throw new PhilotasApiError('request to ' + url + ' failed: ' + (err && err.message ? err.message : err), { url: url.toString(), cause: err });
    } finally {
      clearTimeout(timer);
    }
  }

  return { get, baseUrl, timeoutMs, hasAuth: !!(authToken || (username && password)) };
}
