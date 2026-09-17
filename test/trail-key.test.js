// test/trail-key.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailKey } from '../lib/trail-key.js';

// Captured from the live Sydney transport feed on 2026-08-17. Three buses that
// really were reported on route 2800 at the same moment, 105.8 km apart at the
// widest. Under the old `label`-first order all three shared one key and the
// trail was drawn as a line between them.
const BUSES_ON_ONE_ROUTE = [
  { mode: 'Bus', label: '2800', route: '2800', trip: '1051-BS-2800.170826.11.0742' },
  { mode: 'Bus', label: '2800', route: '2800', trip: '1051-BS-2800.170826.11.0812' },
  { mode: 'Bus', label: '2800', route: '2800', trip: '1051-BS-2800.170826.11.0847' },
];

test('three buses on one route get three different trails', () => {
  const keys = BUSES_ON_ONE_ROUTE.map((p) => trailKey('transport', p));
  assert.equal(new Set(keys).size, 3,
    'buses sharing a route share a trail, so the line drawn is a chord between ' +
    'two different vehicles rather than the path of one — measured 156 km wide ' +
    'in the worst live case');
  // Breaks if: trailKey returns `label` or `route` before `trip`.
});

test('a vehicle keeps the same trail across polls', () => {
  const atFirstPoll = { mode: 'Bus', label: '2800', route: '2800', trip: '1051-BS-2800.170826.11.0742' };
  const atSecondPoll = { ...atFirstPoll };
  assert.equal(trailKey('transport', atFirstPoll), trailKey('transport', atSecondPoll));
  // Breaks if: the key is derived from anything that changes between polls —
  // position, bearing, speed or timestamp. A key that moves gives every vehicle
  // a one-point trail and nothing is ever drawn.
});

// The guard against fixing the collision by making every key unique, which
// would pass the first test while drawing nothing at all.
test('a ferry with a timetabled label still trails, and by its own service', () => {
  const ferry = {
    mode: 'Ferry',
    label: '08:19am Cockatoo Island - Circular Quay',
    route: '9-F8-sj2-1',
    trip: 'CI0745-WD-IN.170826.31.0819',
  };
  assert.equal(trailKey('transport', ferry), 'CI0745-WD-IN.170826.31.0819');
  // Breaks if: trip stops being preferred, or the function starts returning
  // something synthesised rather than a field off the feed.
});

test('a vehicle with no trip falls back rather than losing its trail', () => {
  // Measured: 1 of 3,302 vehicles had no `trip`. It should still draw.
  assert.equal(trailKey('transport', { mode: 'Bus', label: '891', route: '891' }), '891');
  assert.equal(trailKey('transport', { mode: 'Bus', route: '891' }), '891');
  // Breaks if: the fallback chain is removed and those vehicles return null.
});

test('a vehicle with nothing identifying gets no trail, rather than a shared one', () => {
  assert.equal(trailKey('transport', { mode: 'Bus' }), null);
  assert.equal(trailKey('transport', {}), null);
  assert.equal(trailKey('transport', null), null);
  // Breaks if: the function returns a constant, an empty string or a mode name
  // for unidentifiable vehicles — every one of which would then share a trail,
  // which is the defect this file exists to prevent.
});

test('aviation keys on the aircraft, not on anything it shares with others', () => {
  assert.equal(trailKey('aviation', { id: '7c6b2d', flight: 'QFA123' }), '7c6b2d');
  assert.equal(trailKey('aviation', { flight: 'QFA123' }), null);
  // Breaks if: aviation falls back to a flight number. QFA123 is the same
  // designator every day and belongs to a different airframe each time.
});

test('a layer that does not trail returns no key', () => {
  assert.equal(trailKey('vessels', { trip: 'x', label: 'y' }), null);
  assert.equal(trailKey('news', { trip: 'x' }), null);
  // Breaks if: the function starts keying every layer. Trails are opt-in per
  // layer in lib/layers.js and a key here for a layer that does not draw them
  // would accumulate history nothing renders.
});
