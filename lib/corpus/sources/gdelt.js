// GDELT 2.0 DOC API — global news coverage, keyless.
//
// Same endpoint lib/feeds/news.js already polls for the live news map layer,
// but this hits it once PER ENTITY rather than once per region poll, so the
// call volume is much higher: a background pass over ~250 entities is up to
// 250 requests here, not one every five minutes. GDELT IS ALREADY RETURNING
// 429 UNDER THAT LOAD — the single most important operational fact about
// this source — so every call goes through the shared, per-source, backing-
// off queue in lib/corpus/limit.js rather than calling fetch() directly.
//
// The entity's label is quoted as a phrase (`"CORAL PRINCESS"`) rather than
// sent as bare keywords, so a two-word vessel name searches as one phrase
// instead of matching any article containing "coral" or "princess"
// separately.

import { corpusRequest } from '../limit.js';
import { getWithTimeout } from '../../http.js';

const GDELT_DOC = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MAX_RECORDS = 25;

export const id = 'gdelt';
export const sourceLabel = 'GDELT';

// Exported for testing only — pure, no network. See parseSeenDate/buildQuery
// below for the same treatment; nothing outside this module and its test
// should import these directly.
export function buildQuery(entityLabel) {
  const phrase = String(entityLabel || '').trim().replace(/"/g, '');
  return phrase ? `"${phrase}"` : '';
}

// GDELT's seendate is "20260813T091500Z" — bare digits, no separators.
export function parseSeenDate(seendate) {
  if (!seendate || seendate.length < 15) return null;
  const iso = `${seendate.slice(0, 4)}-${seendate.slice(4, 6)}-${seendate.slice(6, 8)}` +
    `T${seendate.slice(9, 11)}:${seendate.slice(11, 13)}:${seendate.slice(13, 15)}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// data.articles -> raw docs. Exported for testing only.
export function mapArticles(data) {
  return (data?.articles || [])
    .filter((a) => a?.url)
    .map((a) => ({
      url: a.url,
      title: a.title || a.domain || null,
      source: 'gdelt',
      published_ms: parseSeenDate(a.seendate),
      snippet: a.title || null, // artlist mode carries no separate snippet field
      language: a.language || null,
    }));
}

export async function search(entity) {
  const query = buildQuery(entity?.entity_label);
  if (!query) return [];

  const url = `${GDELT_DOC}?query=${encodeURIComponent(query)}` +
    `&mode=artlist&format=json&maxrecords=${MAX_RECORDS}&sort=datedesc`;

  const text = await corpusRequest(id, async () => {
    // Same reason as lib/feeds/news.js: GDELT's handshake sits on undici's
    // ten-second connect budget, so the global fetch abandons it more often
    // than it completes. See lib/http.js for the measurements.
    const res = await getWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; parallax-corpus/0.1)' },
      timeoutMs: 30_000,
    });
    if (res.status === 429) {
      const err = new Error('GDELT 429');
      err.status = 429;
      throw err;
    }
    if (!res.ok) throw new Error(`GDELT ${res.status}`);
    return res.text();
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // GDELT reports rate-limiting as an HTML/plain-text 200 body, not a
    // status code — the same behaviour lib/feeds/news.js already works
    // around. Treat it as a rate limit (so the shared limiter backs off)
    // rather than as a parse bug, which would otherwise look like a GDELT
    // format change every time load pushes it into this state.
    const err = new Error('GDELT non-JSON (rate limited)');
    err.status = 429;
    throw err;
  }

  return mapArticles(data);
}
