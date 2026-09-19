import { test } from 'node:test';
import assert from 'node:assert/strict';
import { record, history, latest, sweepStaleKeys } from '../lib/store.js';

const fc = (n) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [i, i] }, properties: {},
  })),
});

test('an idle region keeps its frames until the window closes, then is swept', () => {
  const now = Date.now();
  record('aviation', 'sweeptest-idle', fc(3));
  assert.equal(history('aviation', 'sweeptest-idle', 5).length, 1);

  // Three hours later nothing has recorded for this key, so the per-key trim
  // never runs again — the sweep is the only thing that can reclaim it.
  const removed = sweepStaleKeys(now + 3 * 60 * 60 * 1000);
  assert.ok(removed >= 1, 'the idle key was reclaimed');
  assert.equal(latest('aviation', 'sweeptest-idle'), null);
});

test('a key still inside the window is left alone', () => {
  record('seismic', 'sweeptest-live', fc(1));
  sweepStaleKeys(Date.now());
  assert.ok(latest('seismic', 'sweeptest-live'), 'a fresh key survives the sweep');
});
