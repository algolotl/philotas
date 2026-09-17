// A GET with a timeout we control.
//
// Node's global fetch is undici, and undici gives a connection ten seconds to
// establish — a limit that counts the TLS handshake, not just the TCP connect,
// and that cannot be raised without constructing an undici Dispatcher. undici
// is not a resolvable module here (neither `undici` nor
// `next/dist/compiled/undici` resolves under Node 22.22 in this project), so
// there is nothing to construct.
//
// That ten seconds is not a theoretical limit. Measured against GDELT from
// Canberra on 2026-08-14, three consecutive requests:
//
//     TCP connect   0.24s   0.25s   0.30s
//     TLS handshake 10.43s  10.68s   9.99s
//
// The handshake straddles the deadline, so the news layer failed most of the
// time with a bare `fetch failed` and succeeded occasionally, which reads as a
// flaky integration rather than as a slow host. Re-running the same request
// over node:https with a thirty-second budget returned HTTP 200 and 2,488 bytes
// of articles in 15.96s — the data was always there, we were hanging up on it.
//
// Used only for the sources measured to need it. Everything else stays on
// fetch(), which is better in every respect except this one.

import https from 'node:https';
import { URL } from 'node:url';

// Enough of the Response surface for the callers here — they check `ok` and
// `status` and then read the body once. Deliberately not a polyfill: a partial
// object that admits what it is beats one that looks like a Response and then
// fails on the eleventh property somebody reaches for.
class SlowResponse {
  constructor(status, body) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._body = body;
  }

  async text() { return this._body; }
  async json() { return JSON.parse(this._body); }
}

export function getWithTimeout(url, { headers = {}, timeoutMs = 30_000, maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const target = new URL(url);

    // Only https. An http:// URL would silently drop TLS, and every caller here
    // is talking to a public API over the open internet.
    if (target.protocol !== 'https:') {
      reject(new Error(`getWithTimeout is https-only, got ${target.protocol}`));
      return;
    }

    const request = https.get(target, { headers }, (res) => {
      const { statusCode, headers: responseHeaders } = res;

      if (statusCode >= 300 && statusCode < 400 && responseHeaders.location) {
        res.resume(); // drain, or the socket is held open
        if (maxRedirects <= 0) {
          reject(new Error(`too many redirects from ${url}`));
          return;
        }
        const next = new URL(responseHeaders.location, target).toString();
        // The remaining budget, not a fresh one: three redirects must not turn
        // a thirty-second ceiling into two minutes.
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) {
          reject(new Error(`timed out following redirects from ${url}`));
          return;
        }
        getWithTimeout(next, { headers, timeoutMs: remaining, maxRedirects: maxRedirects - 1 })
          .then(resolve, reject);
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(new SlowResponse(statusCode, body)));
      res.on('error', reject);
    });

    // Covers the whole request, including the handshake — which is the entire
    // reason this function exists.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms (${Date.now() - started}ms elapsed)`));
    });
    request.on('error', reject);
  });
}
