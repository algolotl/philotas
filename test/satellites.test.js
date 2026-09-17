import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as satellite from 'satellite.js';
import {
  fetchSatellites, ommToTle, ommEpochColumns, tleCatalogColumns,
  parseGpJson, parseSatnogsJson, SOURCES,
} from '../lib/feeds/satellites.js';

// The fixtures under test/fixtures are verbatim upstream bytes, not hand-written
// samples:
//   celestrak-omm-25544.kvn and celestrak-tle-25544.txt are the SAME element set
//   in both formats — CelesTrak's gp.php?CATNR=25544 answered with FORMAT=KVN and
//   FORMAT=TLE, captured in one Internet Archive crawl (20241228203144) and
//   retrieved in raw `id_` mode on 2026-08-14. KVN carries the identical field
//   names the GP JSON format uses, which is what makes it a valid stand-in for
//   the JSON when celestrak.org itself is unreachable.
//   celestrak-gp-25544.json is a real GP JSON body (crawl 20240509230539).
//   satnogs-tle-sample.json is three records lifted verbatim from the live
//   https://db.satnogs.org/api/tle/?format=json response on 2026-08-14.
const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name) => fs.readFile(path.join(fixtureDir, name), 'utf8');

// KVN is "KEY = VALUE" per line. Parsed here rather than in the source because
// nothing in production reads KVN — the fixture is in that format only because
// it is the one capture that pairs an OMM record with its own TLE.
function parseKvn(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

// 3D separation of two sub-satellite points, in km. Spherical earth is fine at
// this scale: the numbers being compared here are either identical or thousands
// of km apart, never in the range where the ellipsoid would change the verdict.
function separationKm(a, b) {
  const toEcef = ({ lat, lon, alt }) => {
    const r = 6378.137 + alt;
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
  };
  const [x1, y1, z1] = toEcef(a);
  const [x2, y2, z2] = toEcef(b);
  return Math.hypot(x1 - x2, y1 - y2, z1 - z2);
}

function propagateAt(l1, l2, when) {
  const pv = satellite.propagate(satellite.twoline2satrec(l1, l2), when);
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(when));
  return {
    lat: satellite.degreesLat(geo.latitude),
    lon: satellite.degreesLong(geo.longitude),
    alt: geo.height,
  };
}

const issFrom = (fc) => fc.features.find((f) => f.properties.norad === '25544');

// A source built from fixture bytes. Every fetchSatellites test injects its
// sources so the suite never touches the network — that is also the only way to
// make "the primary threw" a repeatable condition rather than an outage.
const sourceOf = (id, label, elements) => ({ id, label, load: async () => elements });
const failingSource = (id, label, message) => ({
  id, label, load: async () => { throw new Error(message); },
});
// CelesTrak's refusal to resend a catalogue the client already holds, which
// lib/feeds/satellites.js raises as an error carrying `unchanged: true`. A
// successful poll with nothing new in it, not a failure — see the note above
// UNCHANGED_BODY at the foot of this file for the measured shape.
const unchangedSource = (id, label) => ({
  id,
  label,
  load: async () => {
    const err = new Error('GP data has not updated since your last successful download of GROUP=active.');
    err.unchanged = true;
    throw err;
  },
});

async function tempCacheFile(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'parallax-sat-'));
  return path.join(dir, name);
}

// --------------------------------------------------- GP JSON -> TLE conversion

test('ommToTle reproduces CelesTrak\'s own TLE for the ISS, character for character', async () => {
  const omm = parseKvn(await readFixture('celestrak-omm-25544.kvn'));
  const [, expected1, expected2] = (await readFixture('celestrak-tle-25544.txt')).split(/\r?\n/);
  const built = ommToTle(omm);
  assert.equal(built.l1, expected1);
  assert.equal(built.l2, expected2);
  // Both lines are 69 columns including the checksum; a wrong width still
  // compares unequal above, but the length assert says which failure it is.
  assert.equal(built.l1.length, 69);
  assert.equal(built.l2.length, 69);
});

test('the OMM path and the TLE path propagate the ISS to the same position', async () => {
  const omm = parseKvn(await readFixture('celestrak-omm-25544.kvn'));
  const [, expected1, expected2] = (await readFixture('celestrak-tle-25544.txt')).split(/\r?\n/);
  const built = ommToTle(omm);
  const when = new Date('2024-12-29T00:00:00Z');
  const viaTle = propagateAt(expected1, expected2, when);
  const viaOmm = propagateAt(built.l1, built.l2, when);
  // Measured 2026-08-14: 0.000 km. This is the check the spec asks for before
  // moving the primary off the deprecated FORMAT=tle endpoint.
  assert.ok(separationKm(viaTle, viaOmm) < 0.001, `separation ${separationKm(viaTle, viaOmm)} km`);
});

test('ommEpochColumns reads the epoch as UTC, not as local time', () => {
  // ECMAScript reads a bare date-time as local time, so on a UTC+10 machine the
  // naive Date route puts this epoch 10 hours early — a ~276,000 km error for
  // the ISS. CelesTrak writes EPOCH without a zone and declares TIME_SYSTEM=UTC.
  assert.equal(ommEpochColumns('2024-12-28T13:01:00.236640'), '24363.54236385');
  assert.equal(ommEpochColumns('2024-01-01T00:00:00.000000'), '24001.00000000');
  assert.equal(ommEpochColumns('not an epoch'), null);
});

test('ommEpochColumns keeps microsecond precision that a Date round trip would drop', () => {
  // Date carries milliseconds; the epoch carries microseconds, which is the last
  // digit of the 8-decimal day fraction. Truncating gives ...84 instead of ...85.
  assert.equal(ommEpochColumns('2024-12-28T13:01:00.236640').slice(-2), '85');
});

test('tleCatalogColumns uses Alpha-5 above 99999 and gives up above its ceiling', () => {
  assert.equal(tleCatalogColumns(733), '00733');
  assert.equal(tleCatalogColumns(25544), '25544');
  assert.equal(tleCatalogColumns(100000), 'A0000');
  assert.equal(tleCatalogColumns(339999), 'Z9999');
  // Beyond Alpha-5 nothing fits the five columns. The true id still rides in the
  // feature's `norad` property — see the next test.
  assert.equal(tleCatalogColumns(400000), '00000');
});

test('parseGpJson reads a real CelesTrak GP JSON body', async () => {
  const elements = parseGpJson(JSON.parse(await readFixture('celestrak-gp-25544.json')));
  assert.equal(elements.length, 1);
  assert.equal(elements[0].name, 'ISS (ZARYA)');
  assert.equal(elements[0].norad, '25544');
  // The TLE day fraction resolves finer than a millisecond, so epochMs is not
  // an integer — it is only ever used for element-age arithmetic, and rounding
  // it in the source would throw away precision to no end.
  assert.ok(Math.abs(elements[0].epochMs - Date.parse('2024-05-09T20:53:11.139Z')) < 1);
  assert.ok(elements[0].l1.startsWith('1 25544U 98067A'));
});

test('parseGpJson rejects a body that is not an array of records', () => {
  // CelesTrak answers an unknown GROUP with HTTP 200 and a plain-text body, so
  // the status alone would let a text error through as an empty layer.
  assert.throws(() => parseGpJson('No GP data found'), /not an array/);
});

test('parseGpJson keeps a 6-digit catalog number the TLE columns cannot hold', async () => {
  const [real] = JSON.parse(await readFixture('celestrak-gp-25544.json'));
  const elements = parseGpJson([
    { ...real, NORAD_CAT_ID: 100001, OBJECT_NAME: 'ALPHA5 TEST' },
    { ...real, NORAD_CAT_ID: 412345, OBJECT_NAME: 'OVER CEILING' },
  ]);
  // The whole reason for taking the JSON format: these ids survive.
  assert.deepEqual(elements.map((e) => e.norad), ['100001', '412345']);
  // And both still propagate, because SGP4 never reads the catalog number.
  const when = new Date('2024-05-10T00:00:00Z');
  const reference = propagateAt(...Object.values(ommToTle(real)), when);
  for (const e of elements) {
    assert.ok(separationKm(propagateAt(e.l1, e.l2, when), reference) < 0.001);
  }
});

// -------------------------------------------------------------- SatNOGS shape

test('parseSatnogsJson reads a real SatNOGS response and strips the 3LE name prefix', async () => {
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  assert.equal(elements.length, 3);
  assert.equal(elements[0].name, 'ISS (ZARYA)'); // "0 ISS (ZARYA)" upstream
  assert.equal(elements[0].norad, '25544');
});

// ------------------------------------------------------------ source failover

test('fetchSatellites falls back to the next source when the primary throws', async () => {
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const fc = await fetchSatellites(null, {
    sources: [
      failingSource('celestrak', 'CelesTrak GP', 'UND_ERR_CONNECT_TIMEOUT'),
      sourceOf('satnogs', 'SatNOGS DB', elements),
    ],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.equal(fc.source, 'satnogs');
  assert.equal(fc.source_label, 'SatNOGS DB');
  assert.ok(issFrom(fc), 'the ISS must survive the failover');
  // Requirement 6: name what failed rather than quietly serving the fallback.
  assert.match(fc.notice, /CelesTrak GP \(UND_ERR_CONNECT_TIMEOUT\)/);
});

test('fetchSatellites treats an empty response as a failure and moves on', async () => {
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const fc = await fetchSatellites(null, {
    sources: [sourceOf('celestrak', 'CelesTrak GP', []), sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.equal(fc.source, 'satnogs');
  assert.match(fc.notice, /no usable element sets/);
});

// -------------------------------------------------------------- disk fallback

test('fetchSatellites serves the cached element set when every source fails', async () => {
  const cacheFile = await tempCacheFile('elements.json');
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const when = new Date('2026-08-14T11:28:39Z');

  // One good fetch populates the cache …
  const live = await fetchSatellites(null, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile,
    now: when,
  });
  assert.equal(live.source, 'satnogs');
  assert.ok((await fs.readFile(cacheFile, 'utf8')).includes('25544'));

  // … and six hours later, with every source down, the layer still has orbits.
  const sixHoursOn = new Date(when.getTime() + 6 * 3600_000);
  const offline = await fetchSatellites(null, {
    sources: [
      failingSource('celestrak', 'CelesTrak GP', 'UND_ERR_CONNECT_TIMEOUT'),
      failingSource('satnogs', 'SatNOGS DB', 'HTTP 503'),
    ],
    cacheFile,
    now: sixHoursOn,
  });
  assert.equal(offline.source, 'satnogs-cached');
  assert.equal(offline.elements_age_minutes, 360);
  assert.ok(issFrom(offline), 'the cached elements must still produce the ISS');
  assert.match(offline.notice, /CelesTrak GP \(UND_ERR_CONNECT_TIMEOUT\)/);
  assert.match(offline.notice, /SatNOGS DB \(HTTP 503\)/);
  assert.match(offline.notice, /retrieved 360 min ago/);

  // The cache stores elements, not positions, so the cached serve is not a
  // stale position — it is the same propagation done from the same elements.
  // Measured: identical to the last decimal, hence the 1 m tolerance.
  const fresh = await fetchSatellites(null, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('other.json'),
    now: sixHoursOn,
  });
  const a = issFrom(offline).geometry.coordinates;
  const b = issFrom(fresh).geometry.coordinates;
  const gap = separationKm(
    { lon: a[0], lat: a[1], alt: issFrom(offline).properties.altitude_km },
    { lon: b[0], lat: b[1], alt: issFrom(fresh).properties.altitude_km },
  );
  assert.ok(gap < 0.001, `cached and live paths disagree by ${gap} km`);
});

test('fetchSatellites reports plainly when every source fails and nothing is cached', async () => {
  const fc = await fetchSatellites(null, {
    sources: [
      failingSource('celestrak', 'CelesTrak GP', 'UND_ERR_CONNECT_TIMEOUT'),
      failingSource('satnogs', 'SatNOGS DB', 'HTTP 503'),
    ],
    cacheFile: await tempCacheFile('missing.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.equal(fc.source, 'unavailable');
  assert.deepEqual(fc.features, []);
  // "Nothing overhead" and "no data" have to be distinguishable.
  assert.match(fc.notice, /CelesTrak GP \(UND_ERR_CONNECT_TIMEOUT\)/);
  assert.match(fc.notice, /SatNOGS DB \(HTTP 503\)/);
  assert.match(fc.notice, /no cached element set/);
});

test('a corrupt cache file is treated as no cache rather than crashing the layer', async () => {
  const cacheFile = await tempCacheFile('corrupt.json');
  await fs.writeFile(cacheFile, '{"elements":[{"l1":"1 255');
  const fc = await fetchSatellites(null, {
    sources: [failingSource('satnogs', 'SatNOGS DB', 'HTTP 503')],
    cacheFile,
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.equal(fc.source, 'unavailable');
});

// ------------------------------------------------------------- retry pressure

test('a successful fetch is reused rather than re-fetched on the next poll', async () => {
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  let loads = 0;
  const counted = { id: 'satnogs', label: 'SatNOGS DB', load: async () => { loads += 1; return elements; } };
  const shared = { state: null };
  const cacheFile = await tempCacheFile('elements.json');
  const at = new Date('2026-08-14T11:28:39Z');

  await fetchSatellites(null, { sources: [counted], cacheFile, now: at, memory: shared });
  // The poller runs this feed every 10 s; the elements are good for 30 min.
  await fetchSatellites(null, { sources: [counted], cacheFile, now: new Date(at.getTime() + 10_000), memory: shared });
  assert.equal(loads, 1);

  await fetchSatellites(null, { sources: [counted], cacheFile, now: new Date(at.getTime() + 31 * 60_000), memory: shared });
  assert.equal(loads, 2);
});

test('a failed fetch is not retried on every poll', async () => {
  // Without this floor a black-holed host costs a 10.7 s connect timeout every
  // 10 s forever — measured 2026-08-14 against celestrak.org.
  let attempts = 0;
  const dead = {
    id: 'celestrak', label: 'CelesTrak GP',
    load: async () => { attempts += 1; throw new Error('UND_ERR_CONNECT_TIMEOUT'); },
  };
  const shared = { state: null };
  const cacheFile = await tempCacheFile('elements.json');
  const at = new Date('2026-08-14T11:28:39Z');

  await fetchSatellites(null, { sources: [dead], cacheFile, now: at, memory: shared });
  for (const offset of [10_000, 60_000, 4 * 60_000]) {
    await fetchSatellites(null, { sources: [dead], cacheFile, now: new Date(at.getTime() + offset), memory: shared });
  }
  assert.equal(attempts, 1);

  // But a source that comes back is picked up within five minutes, not thirty.
  const recovered = await fetchSatellites(null, { sources: [dead], cacheFile, now: new Date(at.getTime() + 6 * 60_000), memory: shared });
  assert.equal(attempts, 2);
  assert.equal(recovered.source, 'unavailable');
});

// ------------------------------------------------------------------ freshness

test('fetchSatellites drops objects whose elements are too old to mean anything', async () => {
  // The fixture's three real SatNOGS records have epochs of 2026-08-13,
  // 1975-02-11 and 2014-04-09. Measured on the ISS, a 15-day-old element set
  // lands 328.7 km from the truth and a 59-day-old one 11,195.6 km, so the two
  // decades-old objects are confident nonsense, not degraded data.
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const fc = await fetchSatellites(null, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.deepEqual(fc.features.map((f) => f.properties.norad), ['25544']);
  assert.match(fc.notice, /2 object\(s\) dropped for elements older than 14 days/);
});

test('every feature carries the age of the elements it was propagated from', async () => {
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const fc = await fetchSatellites(null, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  // Epoch 26225.85824407 is 2026-08-13T20:35:52Z, ~14.9 h before that instant.
  assert.equal(issFrom(fc).properties.element_age_hours, 15);
  assert.equal(fc.elements_age_minutes, 0);
  assert.equal(fc.elements_retrieved_ms, Date.parse('2026-08-14T11:28:39Z'));
});

// --------------------------------------------------------------- known object

test('the ISS propagates to its measured position', async () => {
  // Ground truth measured 2026-08-14: wheretheiss.at, an independent service
  // running its own propagator, reported the ISS at -30.96077, 84.71754,
  // 432.79 km for timestamp 1786706919 (2026-08-14T11:28:39Z). Propagating the
  // SatNOGS element set to that same instant agreed to 0.001 km.
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const fc = await fetchSatellites(null, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  const iss = issFrom(fc);
  const [lon, lat] = iss.geometry.coordinates;
  const gap = separationKm(
    { lat, lon, alt: iss.properties.altitude_km },
    { lat: -30.96077, lon: 84.71754, alt: 432.79 },
  );
  assert.ok(gap < 1, `ISS is ${gap} km from the independently reported position`);
});

// ------------------------------------------------------------- observer view

test('an observer region keeps only satellites above its horizon', async () => {
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const region = { observer: [149.13, -35.28] }; // Canberra
  const fc = await fetchSatellites(region, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  // The ISS is over the Indian Ocean at that instant, so nothing is up.
  assert.deepEqual(fc.features, []);
  for (const f of fc.features) assert.ok(f.properties.elevation_deg > 0);
});

// -------------------------------------------------------------------- liveness
//
// `live` on this payload answers one question: is what is on the map propagated
// from the newest element set that exists? It is not a headcount, and the four
// tests below exist because it was one.
//
// The line read `(!supply.fromCache || !!supply.unchangedUpstream) && out.length
// > 0`, directly under a comment saying only an unreachable source makes it
// false. The horizon and element-age filters both run after the fetch, so an
// empty result is an ordinary outcome of a fetch that worked — and it declared
// itself not live. Same shape as the news layer's `features.length > 0`, in
// another file; see the catalogue at the top of lib/feed-health.js.

test('a region with nothing overhead is live', async () => {
  // The bug. The ISS is over the Indian Ocean at this instant (see "the ISS
  // propagates to its measured position" above) and the fixture's other two
  // objects are dropped for elements older than 14 days, so an observer at
  // Canberra has an empty sky — while the fetch itself succeeded.
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const fc = await fetchSatellites({ observer: [149.13, -35.28] }, {
    sources: [sourceOf('satnogs', 'SatNOGS DB', elements)],
    cacheFile: await tempCacheFile('elements.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.deepEqual(fc.features, [], 'nothing above the horizon');
  assert.equal(fc.source, 'satnogs', 'and it came off a live fetch, not off disk');
  assert.equal(fc.live, true, 'an empty sky is a fact about the sky, not about the feed');
});

test('an upstream reporting no newer elements leaves the layer live', async () => {
  // The other half of the rule the comment states. CelesTrak answers a
  // conditional request with "GP data has not updated", which is a successful
  // poll carrying nothing new: the elements on disk ARE the newest that exist,
  // so the layer is live and its source is not labelled `-cached`.
  const cacheFile = await tempCacheFile('elements.json');
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const when = new Date('2026-08-14T11:28:39Z');

  await fetchSatellites(null, { sources: [sourceOf('satnogs', 'SatNOGS DB', elements)], cacheFile, now: when });
  const fc = await fetchSatellites(null, {
    sources: [unchangedSource('satnogs', 'SatNOGS DB')],
    cacheFile,
    now: when,
  });

  assert.equal(fc.live, true);
  assert.equal(fc.source, 'satnogs', 'not satnogs-cached — nothing newer exists to be behind');
  assert.match(fc.notice, /reports no newer elements/);
  assert.ok(issFrom(fc), 'and the objects are still being drawn');
});

test('a layer propagating from disk because every source is unreachable is not live', async () => {
  // The guard against fixing the empty-sky case by making the field constant.
  // The cached elements still produce a feature, so nothing about the count
  // separates this from a healthy poll — only where the elements came from.
  const cacheFile = await tempCacheFile('elements.json');
  const elements = parseSatnogsJson(JSON.parse(await readFixture('satnogs-tle-sample.json')));
  const when = new Date('2026-08-14T11:28:39Z');

  await fetchSatellites(null, { sources: [sourceOf('satnogs', 'SatNOGS DB', elements)], cacheFile, now: when });
  const offline = await fetchSatellites(null, {
    sources: [failingSource('satnogs', 'SatNOGS DB', 'HTTP 503')],
    cacheFile,
    now: new Date(when.getTime() + 6 * 3600_000),
  });

  assert.ok(offline.features.length > 0, 'it is still drawing objects');
  assert.equal(offline.source, 'satnogs-cached');
  assert.equal(offline.live, false, 'six-hour-old elements are not the newest that exist');
});

test('a layer with no elements at all is not live', async () => {
  // Every source down and nothing cached returns before the rule above is
  // reached, which is why dropping `&& out.length > 0` costs nothing here.
  const fc = await fetchSatellites(null, {
    sources: [failingSource('satnogs', 'SatNOGS DB', 'HTTP 503')],
    cacheFile: await tempCacheFile('missing.json'),
    now: new Date('2026-08-14T11:28:39Z'),
  });
  assert.equal(fc.source, 'unavailable');
  assert.deepEqual(fc.features, []);
  assert.equal(fc.live, false, 'no data is not the same as nothing overhead');
});

// ---- CelesTrak's conditional-request answer ----
//
// CelesTrak refuses to resend a catalogue the client already downloaded, and
// signals it with HTTP 403 plus an explanatory body rather than 304. Measured
// from the reference deployment, 2026-08-15:
//
//   GROUP=active   -> HTTP 403  "GP data has not updated since your last
//                                successful download of GROUP=active at ..."
//   GROUP=stations -> HTTP 200  [{"OBJECT_NAME":"ISS (ZARYA)", ...
//
// This has cost the layer twice. First res.json() threw a SyntaxError on the
// text body; then a fix read the body but only after `if (!res.ok) throw`,
// which never reached it. Both times the layer failed over to SatNOGS while
// the primary was behaving exactly as documented.

const UNCHANGED_BODY =
  'GP data has not updated since your last successful download of GROUP=active ' +
  'at 2026-08-15 02:44:22 UTC. Data is updated once every 2 hours.';

test('an unchanged answer is recognised on a 403, not just a 200', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return { ok: false, status: 403, text: async () => UNCHANGED_BODY };
  };
  try {
    const celestrak = SOURCES.find((s) => s.id === 'celestrak');
    await assert.rejects(
      () => celestrak.load(),
      (err) => err?.unchanged === true && /has not updated/i.test(err.message),
      'a 403 carrying the unchanged message must raise ElementsUnchanged, not a bare HTTP 403'
    );
    assert.ok(seen.length > 0, 'and it must actually have called upstream');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a genuine 403 is still an error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' });
  try {
    const celestrak = SOURCES.find((s) => s.id === 'celestrak');
    await assert.rejects(
      () => celestrak.load(),
      (err) => !err?.unchanged && /403/.test(err.message),
      'a real block must not be mistaken for a polite refusal to resend'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
