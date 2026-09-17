// lib/feeds/gdelt-gkg.js
//
// GDELT's bulk Global Knowledge Graph feed.
//
// The interactive DOC API rate-limits per address and, measured on 2026-08-15,
// answered 2 of 6 requests at a 20-second spacing while taking 12 to 20 seconds
// each. Its own 429 body says high-traffic users should move to the bulk
// datasets. The bulk file answered in 396 ms with no key and no throttle.
//
// It is also the better source on the merits: every mention carries a geocoded
// latitude and longitude, so articles can be placed where the story is instead
// of on the golden-angle spiral lib/feeds/news.js used to invent.
//
// One file covers the whole world for a 15-minute window, so this is a single
// global poller rather than one query per region.

import { inflateSingleEntryZip } from './gdelt-unzip.js';

const LASTUPDATE_URL = 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const TIMEOUT_MS = 60_000;

export class GkgUnavailable extends Error {
  constructor(detail) {
    super(`GDELT bulk unavailable: ${detail}`);
    this.name = 'GkgUnavailable';
    this.unavailable = true;
  }
}

// GKG 2.1 column indexes, zero-based. The format is documented as 27
// tab-separated fields; these are the ones this system uses.
const COL = { id: 0, date: 1, source: 3, url: 4, locations: 9, organisations: 13, tone: 15 };

// V2DATE is YYYYMMDDHHMMSS in UTC.
function gkgDateToMs(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

// V2LOCATIONS entries are #-delimited and ;-separated:
//   type#fullname#countrycode#adm1#lat#lon#featureid
function parseLocations(field) {
  const out = [];
  for (const entry of String(field || '').split(';')) {
    if (!entry) continue;
    const p = entry.split('#');
    if (p.length < 6) continue;
    const lat = Number(p[4]);
    const lon = Number(p[5]);
    // 0,0 is in the Gulf of Guinea. A record we cannot place is dropped rather
    // than pinned to the null island.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue;
    out.push({ name: p[1], lat, lon });
  }
  return out;
}

export function parseGkg(text) {
  const records = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 16) continue;

    const locations = parseLocations(f[COL.locations]);
    if (locations.length === 0) continue;

    const url = (f[COL.url] || '').trim();
    if (!url) continue;

    const dateMs = gkgDateToMs(f[COL.date]);
    if (dateMs == null) continue;

    records.push({
      id: (f[COL.id] || url).trim(),
      dateMs,
      source: (f[COL.source] || '').trim(),
      url,
      // GKG carries no headline. The source domain and the URL slug are what
      // there is; the title is filled by the corpus enrichment pass later, and
      // presenting the domain is honest in the meantime.
      title: (f[COL.source] || url).trim(),
      locations,
      organisations: (f[COL.organisations] || '').split(';').map((s) => s.trim()).filter(Boolean),
      tone: Number(String(f[COL.tone] || '0').split(',')[0]) || 0,
    });
  }
  return records;
}

export async function latestGkgUrl({ timeoutMs = TIMEOUT_MS } = {}) {
  let text;
  try {
    const res = await fetch(LASTUPDATE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new GkgUnavailable(err?.cause?.code || err.message);
  }
  for (const line of text.split('\n')) {
    const url = line.trim().split(/\s+/).pop();
    if (url && url.endsWith('.gkg.csv.zip')) return url;
  }
  throw new GkgUnavailable('lastupdate.txt listed no gkg file');
}

export async function fetchLatestGkg({ timeoutMs = TIMEOUT_MS } = {}) {
  const url = await latestGkgUrl({ timeoutMs });
  let buffer;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new GkgUnavailable(err?.cause?.code || err.message);
  }
  let content;
  try {
    ({ content } = inflateSingleEntryZip(buffer));
  } catch (err) {
    // A truncated or corrupted download throws here (bad zip signature, an
    // unsupported compression method, or a deflate stream that does not
    // decode) rather than at the fetch above, but it is the same class of
    // failure — the archive did not arrive usable — so it gets the same
    // named signal instead of escaping as a bare Error.
    throw new GkgUnavailable(`corrupt archive (${err.message})`);
  }
  return { records: parseGkg(content.toString('utf8')), url, fetchedMs: Date.now() };
}
