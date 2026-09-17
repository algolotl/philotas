// test/news-store.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, withinBbox, stats, RETENTION_MS, _reset } from '../lib/corpus/news-store.js';

const SYDNEY = { west: 150.5, south: -34.3, east: 151.6, north: -33.4 };

const rec = (over = {}) => ({
  id: over.id ?? 'r1',
  dateMs: over.dateMs ?? Date.now(),
  source: over.source ?? 'example.com',
  url: over.url ?? 'https://example.com/a',
  title: over.title ?? 'example.com',
  locations: over.locations ?? [{ name: 'Sydney, New South Wales, Australia', lat: -33.8833, lon: 151.217 }],
  organisations: over.organisations ?? [],
  tone: over.tone ?? 0,
});

beforeEach(() => _reset());

test('the retention window is 24 hours, and every test below derives its boundaries from it', () => {
  // Measured 2026-08-17 by mutation: halving RETENTION_MS left all 603 tests
  // green. Every boundary in this file is written as `now - RETENTION_MS - 60_000`
  // or `now + RETENTION_MS + 1`, so the window and the probes either side of it
  // move together and the actual duration is never asserted — the same shape as
  // the RRF_K finding in test/corpus-search.test.js. Deriving the boundaries is
  // the right way to write those tests; it just leaves the duration itself needing
  // one assertion of its own.
  //
  // The value is load-bearing beyond this file: lib/corpus/news-store.js holds the
  // window in memory for every region at once, and MAX_RECORDS is sized against
  // roughly 57,000 records a day. Halving the window would not fail anything and
  // would quietly halve how much history a region can show.
  assert.equal(RETENTION_MS, 24 * 60 * 60 * 1000);
});

test('a record inside the bbox is returned at its real coordinate', () => {
  ingest([rec()]);
  const hits = withinBbox(SYDNEY);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].coord, [151.217, -33.8833], 'the coordinate is the mention, not a spiral');
});

test('a record outside the bbox is not returned', () => {
  ingest([rec({ id: 'lon', locations: [{ name: 'London', lat: 51.5074, lon: -0.1276 }] })]);
  assert.equal(withinBbox(SYDNEY).length, 0);
});

test('a record with several locations is placed at the first one inside the bbox', () => {
  ingest([rec({
    id: 'multi',
    locations: [
      { name: 'London', lat: 51.5074, lon: -0.1276 },
      { name: 'Sydney', lat: -33.8688, lon: 151.2093 },
    ],
  })]);
  const [hit] = withinBbox(SYDNEY);
  assert.deepEqual(hit.coord, [151.2093, -33.8688]);
});

test('the same record ingested twice is stored once', () => {
  const first = ingest([rec()]);
  const second = ingest([rec()]);
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(stats().records, 1);
});

test('records older than the retention window are dropped on ingest', () => {
  const now = Date.now();
  const result = ingest([rec({ id: 'old', dateMs: now - RETENTION_MS - 60_000 })], now);
  assert.equal(result.added, 0);
  assert.equal(result.dropped, 1);
  assert.equal(stats().records, 0);
});

test('a resident record is evicted from the store once it ages past retention', () => {
  const now = Date.now();
  ingest([rec({ id: 'first', dateMs: now })], now);
  const later = now + RETENTION_MS + 60_000;
  ingest([rec({ id: 'second', dateMs: later })], later);
  assert.equal(stats().records, 1, 'the aged-out resident is pruned, not just left uncounted');
  const [surviving] = withinBbox(null, 10, later);
  assert.equal(surviving.id, 'second');
});

test('an existing record ages out of query results', () => {
  const now = Date.now();
  ingest([rec({ id: 'fresh', dateMs: now })], now);
  assert.equal(withinBbox(SYDNEY, 10, now).length, 1);
  assert.equal(withinBbox(SYDNEY, 10, now + RETENTION_MS + 1).length, 0);
});

test('a null bbox returns everything, newest first', () => {
  const now = Date.now();
  ingest([
    rec({ id: 'a', dateMs: now - 1000 }),
    rec({ id: 'b', dateMs: now, locations: [{ name: 'London', lat: 51.5074, lon: -0.1276 }] }),
  ], now);
  const all = withinBbox(null, 10, now);
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'b', 'newest first');
});

test('the limit is honoured', () => {
  const now = Date.now();
  ingest(Array.from({ length: 20 }, (_, i) => rec({ id: `r${i}`, dateMs: now - i })), now);
  assert.equal(withinBbox(SYDNEY, 5, now).length, 5);
});
