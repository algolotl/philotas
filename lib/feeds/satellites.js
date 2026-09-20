// Satellites — orbital layer, region-aware.
//
// We pull general perturbations (GP) element sets, propagate each to the current
// instant with satellite.js, and emit sub-satellite points. If the region has an
// observer (e.g. Canberra) we keep only satellites currently above that horizon.
// The world region has no observer, so we show the full orbital scatter, capped.
//
// Three things keep this layer alive when CelesTrak is not:
//
//  1. A keyless second source. Measured 2026-08-14 from this workstation:
//     GET https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=json
//     -> TypeError: fetch failed, cause UND_ERR_CONNECT_TIMEOUT after 10,700 ms.
//     Plain http:// on :80 fails the same way (10,311 ms). The same minute,
//     GET https://db.satnogs.org/api/tle/?format=json -> HTTP 200, 523,916
//     bytes, 1,670 objects, no credentials and no account.
//
//  2. GP JSON rather than FORMAT=tle. CelesTrak exhausted the 5-digit catalog
//     numbers on 2026-07-11 and a 6-digit number cannot be written into the TLE
//     columns at all. The JSON carries NORAD_CAT_ID as a number, so the true id
//     survives even when the TLE lines we synthesise for satellite.js cannot
//     spell it. See ommToTle.
//
//  3. A disk cache of the *elements*, not of the positions. Propagation is
//     local, so an outage costs freshness rather than the whole layer. Measured
//     ISS (25544) error against the element set current at 2026-03-10T11:33:06Z,
//     propagating archived CelesTrak elements of increasing age to that instant:
//     1.03 d -> 1.0 km, 11.94 d -> 97.3 km, 15.04 d -> 328.7 km, 59 d ->
//     11,195.6 km. Hence MAX_ELEMENT_AGE_DAYS below, and hence the age is
//     reported on every response rather than hidden.
//
// satellite.js 5.0.0 exports twoline2satrec and no OMM entry point (measured:
// its module exports are sgp4, twoline2satrec, propagate, gstime, … and nothing
// that takes a GP record), so the JSON path has to synthesise TLE lines.

import fs from 'node:fs/promises';
import path from 'node:path';
import * as satellite from 'satellite.js';

// 'active' is the whole operational catalogue rather than the curated
// naked-eye list. Measured 2026-08-15: visual 157 objects, stations 22,
// active 16,343.
//
// The two curated groups gave 179 tracked objects, of which about 5.8% sit
// above any one observer's horizon at a time — so London rendered 5 satellites
// and looked broken to anyone who knows how many are actually up there. The
// full catalogue puts roughly 940 above that same horizon.
//
// It is affordable. SGP4 propagation measured 16.5 microseconds per object on
// the reference deployment, so the whole catalogue costs about 270 ms per refresh against a 10s
// TTL. Elements are fetched at most once per MEMORY_TTL_MS and only the
// propagation repeats.
//
// 'stations' is kept alongside it: the ISS and the crewed vehicles are the
// objects people look for by name, and being in a curated group guarantees
// they survive any filtering applied to the bulk catalogue.
const CELESTRAK_GROUPS = ['active', 'stations'];
const celestrakUrl = (group) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;

// SatNOGS DB republishes elements it collects from Space-Track, CelesTrak and
// the amateur trackers; the measured 1,670-object response carried tle_source
// values of Space-Track.org, SatNOGS Team, CalPoly, McCants, Celestrak
// (SatNOGS), Celestrak (supplemental), Satellite Team and Celestrak (active).
// It is a different host and a different upstream path to CelesTrak's, which is
// the only property that matters for a fallback.
const SATNOGS_URL = 'https://db.satnogs.org/api/tle/?format=json';

// Elements older than this are dropped rather than plotted. The 15-day archived
// ISS element set above put the station 328.7 km from where it was — a marker
// that is wrong by a third of Australia is worse than a marker that is absent.
// Measured 2026-08-14: 1,670 objects in the SatNOGS response, of which 1,412
// carried an epoch inside 48 h; the long tail runs to 51 years (dead objects
// whose last element set was never superseded).
const MAX_ELEMENT_AGE_DAYS = 14;

// Bounds the failover. Measured round trips on 2026-08-14: SatNOGS 5,112 ms for
// the full 523,916-byte body, CelesTrak's connect timeout fires at ~10,700 ms.
// 20 s leaves headroom over the slowest success without letting a black-holed
// host stall the poller indefinitely.
const FETCH_TIMEOUT_MS = 20_000;

const USER_AGENT = 'philotas-demo/0.1';

// Elements change on the order of hours; positions are recomputed every request.
// Caching the download for 30 min and re-propagating per request is what stops
// us hammering the upstream.
const MEMORY_TTL_MS = 30 * 60 * 1000;

// How long a failed attempt is remembered before the sources are tried again.
// The poller runs this feed every 10 s (FEEDS.satellites.ttl in lib/config.js)
// and a full attempt against the dead host measured 13,735 ms end to end on
// 2026-08-14, so without a floor an outage means a permanently in-flight fetch
// re-opening a connection to a black hole several times a minute. Five minutes
// still picks CelesTrak back up promptly when it returns.
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;

const DEFAULT_CACHE_FILE = () => path.join(process.cwd(), '.data', 'satellite-elements.json');

// ---------------------------------------------------------------- TLE parsing

// TLE's two-digit year pivots at 57 — the catalogue starts with Sputnik in 1957.
function tleEpochMs(line1) {
  const raw = line1.slice(18, 32);
  const yy = Number(raw.slice(0, 2));
  const dayOfYear = Number(raw.slice(2));
  if (!Number.isFinite(yy) || !Number.isFinite(dayOfYear)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86400000;
}

// There is deliberately no TLE-text parser here any more. Both sources serve
// JSON, and keeping a parser for the deprecated FORMAT=tle endpoint would be
// dead code inviting someone to point the primary back at it.

// ------------------------------------------------------- GP JSON -> TLE lines

// Alpha-5 lets catalog numbers 100000–339999 ride in the five TLE id columns by
// replacing the leading digit with a letter. I and O are omitted because they
// read as 1 and 0. Nothing above 339999 fits, which is precisely the problem
// CelesTrak flagged when it ran out of 5-digit numbers on 2026-07-11 — so above
// that we write a placeholder into the columns and keep the real number in the
// feature's `norad` property. Measured 2026-08-14 that this is safe: propagating
// the ISS with its id columns rewritten to 'Z9999' moved the ECI position by
// 0.000 km, and satellite.js keeps satnum as the raw string 'Z9999' rather than
// feeding it to SGP4. The catalog number is an identifier, not a parameter.
const ALPHA5_LEAD = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function tleCatalogColumns(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 0) return '00000';
  if (n < 100000) return String(n).padStart(5, '0');
  const lead = Math.floor(n / 10000);
  if (lead - 10 < ALPHA5_LEAD.length) return ALPHA5_LEAD[lead - 10] + String(n % 10000).padStart(4, '0');
  return '00000';
}

// TLE checksum: digits summed, a minus sign counts 1, everything else 0, mod 10.
function tleChecksum(first68) {
  let total = 0;
  for (const ch of first68) {
    if (ch >= '0' && ch <= '9') total += Number(ch);
    else if (ch === '-') total += 1;
  }
  return total % 10;
}

// OMM EPOCH -> the TLE's YYDDD.DDDDDDDD columns.
//
// Parsed off the string rather than through Date for two reasons, both of which
// silently corrupt the epoch otherwise. First, CelesTrak writes
// "2024-12-28T13:01:00.236640" with no zone, and ECMAScript reads a bare
// date-time as LOCAL time — on a UTC+10 machine that is a 10-hour error.
// Second, Date carries milliseconds and the epoch carries microseconds, which
// costs the last digit of the 8-decimal day fraction.
export function ommEpochColumns(epoch) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(epoch));
  if (!m) return null;
  const [, year, month, day, hh, mm, ss] = m;
  const dayOfYear = Math.round((Date.UTC(+year, +month - 1, +day) - Date.UTC(+year, 0, 1)) / 86400000) + 1;
  const fraction = (+hh * 3600 + +mm * 60 + +ss) / 86400;
  // toFixed(8) can carry to 1.00000000 within 0.4 ms of midnight, which would
  // write the fraction onto the wrong day.
  const rounded = fraction.toFixed(8);
  if (rounded.startsWith('1')) return String(year).slice(2) + String(dayOfYear + 1).padStart(3, '0') + '.00000000';
  return String(year).slice(2) + String(dayOfYear).padStart(3, '0') + rounded.slice(1);
}

// Sign column + implied leading decimal point, e.g. 0.00025222 -> " .00025222".
function tleDecimalColumns(value) {
  const v = Number(value) || 0;
  return (v < 0 ? '-' : ' ') + Math.abs(v).toFixed(8).slice(1);
}

// TLE's modified exponential: sign, 5 mantissa digits with an implied leading
// decimal point, exponent sign, one exponent digit. 0.0004426 -> " 44260-3".
function tleExponentColumns(value) {
  const v = Number(value) || 0;
  if (v === 0) return ' 00000+0';
  const sign = v < 0 ? '-' : ' ';
  let mantissa = Math.abs(v);
  let exponent = 0;
  while (mantissa >= 1) { mantissa /= 10; exponent += 1; }
  while (mantissa < 0.1) { mantissa *= 10; exponent -= 1; }
  let digits = Math.round(mantissa * 1e5);
  if (digits >= 100000) { digits = Math.round(digits / 10); exponent += 1; }
  return sign + String(digits).padStart(5, '0') + (exponent < 0 ? '-' : '+') + Math.abs(exponent);
}

// Build the two TLE lines from a CelesTrak GP JSON record.
//
// Verified against CelesTrak's own output rather than against the format spec:
// the Internet Archive holds byte-identical captures of
// gp.php?CATNR=25544&FORMAT=KVN and &FORMAT=TLE from the same crawl instant
// (20241228203144), i.e. the same element set in both the OMM field names the
// JSON format uses and in TLE. Measured 2026-08-14: this function reproduces
// that TLE string exactly, character for character, on both lines, and the two
// propagate to an identical ECI position (separation 0.000 km).
export function ommToTle(gp) {
  const columns = tleCatalogColumns(gp.NORAD_CAT_ID);
  const epoch = ommEpochColumns(gp.EPOCH);
  if (!epoch) return null;

  // "1998-067A" -> "98067A". Like the catalog number this is an identifier that
  // SGP4 never reads, so a malformed one costs nothing but a cosmetic column.
  const designator = String(gp.OBJECT_ID || '').replace('-', '').slice(2).padEnd(8).slice(0, 8);

  const line1 =
    '1 ' + columns + (gp.CLASSIFICATION_TYPE || 'U') + ' ' + designator + ' ' + epoch +
    ' ' + tleDecimalColumns(gp.MEAN_MOTION_DOT) +
    ' ' + tleExponentColumns(gp.MEAN_MOTION_DDOT) +
    ' ' + tleExponentColumns(gp.BSTAR) +
    ' ' + (gp.EPHEMERIS_TYPE ?? 0) +
    ' ' + String(gp.ELEMENT_SET_NO ?? 999).padStart(4);

  const line2 =
    '2 ' + columns +
    ' ' + Number(gp.INCLINATION).toFixed(4).padStart(8) +
    ' ' + Number(gp.RA_OF_ASC_NODE).toFixed(4).padStart(8) +
    ' ' + Number(gp.ECCENTRICITY).toFixed(7).slice(2) +
    ' ' + Number(gp.ARG_OF_PERICENTER).toFixed(4).padStart(8) +
    ' ' + Number(gp.MEAN_ANOMALY).toFixed(4).padStart(8) +
    ' ' + Number(gp.MEAN_MOTION).toFixed(8).padStart(11) +
    String(gp.REV_AT_EPOCH ?? 0).padStart(5);

  return { l1: line1 + tleChecksum(line1), l2: line2 + tleChecksum(line2) };
}

export function parseGpJson(body) {
  // CelesTrak answers a bad GROUP with a 200 and a plain-text body, so "did it
  // parse as an array of records" is the check that matters, not the status.
  if (!Array.isArray(body)) throw new Error('GP JSON body is not an array of records');
  const out = [];
  for (const gp of body) {
    const lines = ommToTle(gp);
    if (!lines) continue;
    out.push({
      name: gp.OBJECT_NAME || String(gp.NORAD_CAT_ID),
      // The number from the JSON, not the TLE columns — this is the whole point
      // of taking the JSON format.
      norad: String(gp.NORAD_CAT_ID),
      l1: lines.l1,
      l2: lines.l2,
      epochMs: tleEpochMs(lines.l1),
    });
  }
  return out;
}

export function parseSatnogsJson(body) {
  if (!Array.isArray(body)) throw new Error('SatNOGS body is not an array of records');
  return body
    .filter((r) => r?.tle1?.startsWith('1 ') && r?.tle2?.startsWith('2 '))
    .map((r) => ({
      // SatNOGS prefixes the name line with the "0 " of the 3LE convention.
      name: String(r.tle0 || '').replace(/^0\s+/, '') || String(r.norad_cat_id),
      norad: String(r.norad_cat_id),
      l1: r.tle1,
      l2: r.tle2,
      epochMs: tleEpochMs(r.tle1),
    }));
}

// ------------------------------------------------------------------- sources

// Raised when CelesTrak declines to resend data we already hold. Not an error:
// it is the polite path, and the caller should keep using its cached elements.
export class ElementsUnchanged extends Error {
  constructor(detail) {
    super(`elements unchanged upstream: ${detail}`);
    this.name = 'ElementsUnchanged';
    this.unchanged = true;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // Body first, status second. CelesTrak signals "you already have this" with
  // HTTP 403 and an explanatory body, not with 304 — so checking res.ok first
  // throws before the explanation is ever read, which is exactly what an
  // earlier version of this function did. Measured from the reference deployment, 2026-08-15:
  //
  //   GROUP=active   -> HTTP 403  "GP data has not updated since your last
  //                                successful download of GROUP=active at ..."
  //   GROUP=stations -> HTTP 200  [{"OBJECT_NAME":"ISS (ZARYA)", ...
  //
  // The 403 is not a block and not a rate limit. It is a conditional-request
  // answer, and the correct response is to keep using the elements we already
  // hold rather than to fail over to another source.
  const text = await res.text();
  const head = text.slice(0, 200);
  if (/has not updated since your last successful/i.test(head)) {
    throw new ElementsUnchanged(head.replace(/\s+/g, ' ').trim());
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON body from ${new URL(url).host}: ${head.slice(0, 80)}`);
  }
}

export const SOURCES = [
  {
    // Canonical, and first even while it is down: the outage may be temporary
    // and CelesTrak's curated groups are what this layer was designed around.
    id: 'celestrak',
    label: 'CelesTrak GP',
    async load() {
      const bodies = await Promise.all(CELESTRAK_GROUPS.map((g) => fetchJson(celestrakUrl(g))));
      return bodies.flatMap(parseGpJson);
    },
  },
  {
    id: 'satnogs',
    label: 'SatNOGS DB',
    async load() {
      return parseSatnogsJson(await fetchJson(SATNOGS_URL));
    },
  },
];

// --------------------------------------------------------------- disk cache

async function readCachedElements(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(parsed?.elements) || parsed.elements.length === 0) return null;
    return parsed;
  } catch {
    // Missing, unreadable or half-written: indistinguishable from having no
    // cache, and treating it as such is the only safe reading.
    return null;
  }
}

async function writeCachedElements(file, payload) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename. A crash midway through a plain write leaves a truncated
    // JSON file, and this cache exists precisely to be read when everything else
    // has failed — the one moment a corrupt file cannot be recovered from.
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(payload));
    await fs.rename(temp, file);
  } catch {
    // A read-only or full disk costs us the outage cushion, not this request.
  }
}

// ------------------------------------------------------------ element supply

// { at, ttl, record } — `at`/`ttl` are the retry bookkeeping, `record` is what
// callers see. Keeping them apart stops poll timing leaking into the payload.
const moduleMemory = { state: null };

// Try each source in order; fall back to the disk cache; otherwise report what
// was tried. Returns { elements, sourceId, sourceLabel, retrievedAtMs, fromCache,
// errors } — never throws, because an empty labelled layer tells an operator
// more than a stack trace that the cache layer would flatten to one string.
async function getElements({ sources, cacheFile, now, memory }) {
  if (memory.state && now - memory.state.at < memory.state.ttl) return memory.state.record;

  const errors = [];
  for (const source of sources) {
    try {
      const elements = await source.load();
      if (!elements.length) throw new Error('no usable element sets in response');
      const record = {
        elements,
        sourceId: source.id,
        sourceLabel: source.label,
        retrievedAtMs: now,
        fromCache: false,
        errors,
      };
      memory.state = { at: now, ttl: MEMORY_TTL_MS, record };
      await writeCachedElements(cacheFile, record);
      return record;
    } catch (err) {
      // "Unchanged" is a success with nothing new in it. CelesTrak says so in
      // plain text rather than with a 304, and treating it as a failure sent
      // this layer to the fallback source on most refreshes. Serve the elements
      // we already hold, from this source, and say nothing alarming about it.
      if (err?.unchanged) {
        const cached = await readCachedElements(cacheFile);
        if (cached?.elements?.length) {
          const record = {
            elements: cached.elements,
            sourceId: cached.sourceId ?? source.id,
            sourceLabel: cached.sourceLabel ?? source.label,
            retrievedAtMs: cached.retrievedAtMs,
            fromCache: true,
            unchangedUpstream: true,
            errors,
          };
          // Held for a full memory TTL: upstream has told us there is nothing
          // newer, so asking again sooner cannot produce a different answer.
          memory.state = { at: now, ttl: MEMORY_TTL_MS, record };
          return record;
        }
        // Nothing cached to pair it with — the elements exist upstream but this
        // client has no copy, which is only reachable after losing the cache
        // file. Fall through and let the next source answer.
        errors.push(`${source.label} (unchanged upstream, no local copy)`);
        continue;
      }
      // A bare "fetch failed" is what undici gives for everything from a refused
      // connection to an expired certificate, and it leaves an operator unable to
      // tell whether the fault is ours or the source's. Carry the cause code.
      const cause = err?.cause?.code || err?.message || String(err);
      errors.push(`${source.label} (${cause})`);
    }
  }

  const cached = await readCachedElements(cacheFile);
  const record = cached
    ? {
        elements: cached.elements,
        sourceId: cached.sourceId,
        sourceLabel: cached.sourceLabel,
        retrievedAtMs: cached.retrievedAtMs,
        fromCache: true,
        errors,
      }
    : { elements: [], sourceId: null, sourceLabel: null, retrievedAtMs: null, fromCache: false, errors };
  // Remember the failure too, so a dead host is retried on a five-minute floor
  // instead of on every poll.
  memory.state = { at: now, ttl: RETRY_AFTER_FAILURE_MS, record };
  return record;
}

// ------------------------------------------------------------------ the feed

export async function fetchSatellites(region, options = {}) {
  const sources = options.sources || SOURCES;
  const cacheFile = options.cacheFile || DEFAULT_CACHE_FILE();
  const now = options.now instanceof Date ? options.now : new Date();
  const nowMs = now.getTime();
  // Tests inject `sources`; give them a private memory unless they pass one
  // explicitly, so one test's successful fetch cannot satisfy the next test's.
  const memory = options.memory || (options.sources ? { state: null } : moduleMemory);

  const supply = await getElements({ sources, cacheFile, now: nowMs, memory });

  if (!supply.elements.length) {
    // Requirement of the layer, not a nicety: an operator staring at an empty
    // orbital layer has to be able to tell "nothing overhead" from "no data".
    const tried = supply.errors.length ? supply.errors.join('; ') : 'no sources configured';
    return {
      type: 'FeatureCollection',
      features: [],
      generated: nowMs,
      source: 'unavailable',
      live: false,
      notice: `No orbital elements — tried ${tried}, and no cached element set on disk.`,
    };
  }

  const observerCoord = region?.observer;
  const observer = observerCoord
    ? {
        longitude: satellite.degreesToRadians(observerCoord[0]),
        latitude: satellite.degreesToRadians(observerCoord[1]),
        height: 0.5,
      }
    : null;
  const cap = region?.params?.satellites?.cap;

  const gmst = satellite.gstime(now);
  const maxEpochAgeMs = MAX_ELEMENT_AGE_DAYS * 86400000;
  const features = [];
  let staleElements = 0;

  // De-duped by NORAD id — CelesTrak's visual and stations groups overlap on the
  // ISS, and SatNOGS carries several element sets for some objects.
  const seen = new Set();

  for (const element of supply.elements) {
    if (seen.has(element.norad)) continue;
    seen.add(element.norad);

    // Dead objects whose last element set was never superseded propagate to
    // confident nonsense. Drop them before they reach the map.
    if (element.epochMs != null && nowMs - element.epochMs > maxEpochAgeMs) { staleElements += 1; continue; }

    let satrec;
    try { satrec = satellite.twoline2satrec(element.l1, element.l2); } catch { continue; }
    const pv = satellite.propagate(satrec, now);
    if (!pv?.position) continue;

    const geo = satellite.eciToGeodetic(pv.position, gmst);
    if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) continue;

    let elevation = null;
    if (observer) {
      const look = satellite.ecfToLookAngles(observer, satellite.eciToEcf(pv.position, gmst));
      elevation = satellite.radiansToDegrees(look.elevation);
      if (elevation <= 0) continue; // below the observer's horizon — skip
    }

    const v = pv.velocity;
    const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null;

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [satellite.degreesLong(geo.longitude), satellite.degreesLat(geo.latitude)] },
      properties: {
        layer: 'satellites',
        title: element.name,
        norad: element.norad,
        altitude_km: Math.round(geo.height),
        elevation_deg: elevation == null ? null : Math.round(elevation),
        speed_kms: speed ? Number(speed.toFixed(2)) : null,
        // Per-object, because a source's element sets are not uniformly fresh:
        // the measured SatNOGS response held 1,670 objects with epochs ranging
        // from 8.1 h (median) to 51 years.
        element_age_hours: element.epochMs == null ? null : Math.round((nowMs - element.epochMs) / 3600000),
      },
    });
  }

  // Observer view: nearest-to-overhead first. World view: just cap.
  if (observer) features.sort((a, b) => b.properties.elevation_deg - a.properties.elevation_deg);
  const out = cap ? features.slice(0, cap) : features;

  const elementAgeMinutes = supply.retrievedAtMs == null ? null : Math.round((nowMs - supply.retrievedAtMs) / 60000);
  const notes = [];
  if (supply.errors.length) notes.push(`Live fetch failed: ${supply.errors.join('; ')}.`);
  // Serving from cache because upstream says nothing has changed is a different
  // claim from serving from cache because upstream is unreachable. The first is
  // the freshest data that exists; only the second is degraded.
  if (supply.unchangedUpstream) {
    notes.push(`${supply.sourceLabel} reports no newer elements; these are ${elementAgeMinutes} min old and current.`);
  } else if (supply.fromCache) {
    notes.push(`Propagated from cached ${supply.sourceLabel} elements retrieved ${elementAgeMinutes} min ago.`);
  }
  if (staleElements) notes.push(`${staleElements} object(s) dropped for elements older than ${MAX_ELEMENT_AGE_DAYS} days.`);

  return {
    type: 'FeatureCollection',
    features: out,
    generated: nowMs,
    // Liveness is its own claim, separate from the notice — and separate again
    // from how many objects happen to be overhead.
    //
    // These three notes mean different things and only one of them is about
    // whether the data is current: a failed PRIMARY whose fallback succeeded is
    // live, dropping stale objects is live, and propagating from the disk cache
    // is not. Folding all three into `notice` and letting the interface infer
    // "not live" from the mere presence of one is what put a NOT LIVE banner
    // over a layer that was showing 109 satellites from a live SatNOGS fetch.
    // Elements upstream has confirmed are the newest that exist are live, even
    // though they came off disk. Only an unreachable source makes this false.
    //
    // That is what the comment said before this fix, and the line under it then
    // ended `&& out.length > 0`, which is not that rule. The horizon filter and
    // the element-age filter both run AFTER the fetch, so an empty result is an
    // ordinary outcome of a fetch that worked. How ordinary depends on which
    // source answered: the note at the top of this file measured the curated
    // groups at 179 objects, of which London had 5 above its horizon — on an
    // element set that size an empty sky is a normal state, not an exotic one.
    // Every one of those moments declared itself not live while its source had
    // answered perfectly. Emptiness is a fact about the sky. See the catalogue
    // at the top of lib/feed-health.js for the other times this project has
    // read "nothing to report" as "not working".
    //
    // Nothing is lost by dropping the conjunct. The one case it looked like it
    // covered — no elements at all, from an unreachable source with nothing
    // cached — returns above with `live: false` and never reaches this line.
    live: !supply.fromCache || !!supply.unchangedUpstream,
    // Requirement 5 of the source-resilience spec: a position propagated from
    // six-hour-old elements is a different claim to one propagated from fresh
    // ones, and the operator cannot tell them apart from the marker alone.
    source: supply.fromCache && !supply.unchangedUpstream ? `${supply.sourceId}-cached` : supply.sourceId,
    source_label: supply.sourceLabel,
    elements_retrieved_ms: supply.retrievedAtMs,
    elements_age_minutes: elementAgeMinutes,
    ...(notes.length ? { notice: notes.join(' ') } : {}),
  };
}
