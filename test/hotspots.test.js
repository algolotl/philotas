import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, acquiredAtMs, fetchHotspots } from '../lib/feeds/hotspots.js';

// parseCsv and acquiredAtMs are exported from lib/feeds/hotspots.js purely so
// they can be reached here — see the "Exported for testing only" comment
// beside each in the source. Neither is used by anything outside that module.

test('parseCsv turns a header row + data rows into objects keyed by header', () => {
  const csv = 'latitude,longitude,frp\n-33.85,151.20,12.4\n-33.90,151.25,3.1';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { latitude: '-33.85', longitude: '151.20', frp: '12.4' });
  assert.deepEqual(rows[1], { latitude: '-33.90', longitude: '151.25', frp: '3.1' });
});

test('parseCsv trims whitespace around header and cell values', () => {
  const csv = ' latitude , longitude \n -33.85 , 151.20 ';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], { latitude: '-33.85', longitude: '151.20' });
});

test('parseCsv returns an empty array for a header-only or empty input', () => {
  assert.deepEqual(parseCsv('latitude,longitude'), []);
  assert.deepEqual(parseCsv(''), []);
});

test('parseCsv fills a short row\'s missing trailing cells with empty strings', () => {
  const csv = 'latitude,longitude,frp\n-33.85,151.20';
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], { latitude: '-33.85', longitude: '151.20', frp: '' });
});

test('acquiredAtMs joins an acq_date and acq_time into a UTC epoch', () => {
  const ms = acquiredAtMs('2026-08-14', '0713');
  assert.equal(ms, Date.parse('2026-08-14T07:13:00Z'));
});

test('acquiredAtMs left-pads a short acq_time (FIRMS drops leading zeros, e.g. "13" for 00:13)', () => {
  const ms = acquiredAtMs('2026-08-14', '13');
  assert.equal(ms, Date.parse('2026-08-14T00:13:00Z'));
});

test('acquiredAtMs returns null when date or time is missing', () => {
  assert.equal(acquiredAtMs(null, '0713'), null);
  assert.equal(acquiredAtMs('2026-08-14', null), null);
  assert.equal(acquiredAtMs('', ''), null);
});

test('acquiredAtMs returns null for an unparseable date', () => {
  assert.equal(acquiredAtMs('not-a-date', '0713'), null);
});

// fetchHotspots itself needs a network round trip to FIRMS once a MAP_KEY is
// configured, which is out of scope for a unit suite. Its unconfigured path
// is pure and worth pinning, since it's the default state of a fresh
// deployment and the point where a misconfigured key must fail safe rather
// than throw.
test('fetchHotspots without a FIRMS_MAP_KEY serves an empty, labelled collection instead of failing', async () => {
  const saved = process.env.FIRMS_MAP_KEY;
  delete process.env.FIRMS_MAP_KEY;
  try {
    const fc = await fetchHotspots();
    assert.equal(fc.source, 'unconfigured');
    assert.deepEqual(fc.features, []);
    assert.ok(fc.notice, 'must explain why the layer is empty');
  } finally {
    if (saved !== undefined) process.env.FIRMS_MAP_KEY = saved;
  }
});
