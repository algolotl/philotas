import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMetres } from '../lib/geo.js';

// Mirrors ingest/test/geo.test.js's Sydney Harbour fixture. lib/geo.js is a
// deliberate duplicate of ingest/src/geo.js (see the comment at the top of
// that file) rather than a shared module, so both copies need the same pin.
const CIRCULAR_QUAY = [151.2108, -33.8610];
const MANLY_WHARF = [151.2848, -33.7998];

test('haversineMetres matches a known Sydney Harbour distance', () => {
  const d = haversineMetres(CIRCULAR_QUAY, MANLY_WHARF);
  assert.ok(d > 9000 && d < 10500, `expected ~9.6km, got ${Math.round(d)}m`);
});

test('haversineMetres is zero for identical points', () => {
  assert.equal(haversineMetres(CIRCULAR_QUAY, CIRCULAR_QUAY), 0);
});

test('haversineMetres is symmetric', () => {
  const there = haversineMetres(CIRCULAR_QUAY, MANLY_WHARF);
  const back = haversineMetres(MANLY_WHARF, CIRCULAR_QUAY);
  assert.ok(Math.abs(there - back) < 1e-6);
});
