import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVesselState,
  applyReport,
  getTrack,
  allVessels,
  pruneStale,
  getObservedNames,
  recordObservedName,
} from '../src/vessel-state.js';

const report = (mmsi, timestamp_ms, overrides = {}) => ({
  mmsi,
  name: 'TEST',
  ship_type: 'cargo',
  destination: 'SYDNEY',
  position: [151.2, -33.85],
  speed_over_ground_knots: 10,
  course_over_ground_degrees: 90,
  timestamp_ms,
  ...overrides,
});

test('records a first report as a new vessel', () => {
  const state = createVesselState();
  const { vessel } = applyReport(state, report('111', 1000));
  assert.equal(vessel.mmsi, '111');
  assert.equal(vessel.first_seen_ms, 1000);
  assert.equal(allVessels(state).length, 1);
});

test('appends positions to a track in timestamp order', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000));
  applyReport(state, report('111', 2000));
  applyReport(state, report('111', 3000));
  const track = getTrack(state, '111');
  assert.equal(track.points.length, 3);
  assert.deepEqual(track.points.map((p) => p.timestamp_ms), [1000, 2000, 3000]);
});

test('ignores an out-of-order report older than the latest', () => {
  // A late report cannot change a decision already made from a later fix.
  const state = createVesselState();
  applyReport(state, report('111', 3000));
  applyReport(state, report('111', 1000));
  const track = getTrack(state, '111');
  assert.equal(track.points.length, 1, 'stale report should be dropped');
  assert.equal(track.points[0].timestamp_ms, 3000);
});

test('ignores a duplicate report at the same timestamp', () => {
  const state = createVesselState();
  applyReport(state, report('111', 3000));
  applyReport(state, report('111', 3000));
  assert.equal(getTrack(state, '111').points.length, 1);
});

test('caps track length to the configured maximum', () => {
  const state = createVesselState({ maximumTrackPoints: 3 });
  for (let i = 1; i <= 6; i += 1) applyReport(state, report('111', i * 1000));
  const track = getTrack(state, '111');
  assert.equal(track.points.length, 3);
  assert.equal(track.points[0].timestamp_ms, 4000, 'oldest points are dropped first');
});

test('keeps the latest identity fields on the vessel', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000, { destination: 'SYDNEY' }));
  const { vessel } = applyReport(state, report('111', 2000, { destination: 'MELBOURNE' }));
  assert.equal(vessel.destination, 'MELBOURNE');
});

test('retains a known identity field when a later report omits it', () => {
  // Position reports and static reports are different AIS message types; a
  // position report carries no name, and must not erase one already known.
  const state = createVesselState();
  applyReport(state, report('111', 1000, { name: 'SEA HORSE' }));
  const { vessel } = applyReport(state, report('111', 2000, { name: undefined }));
  assert.equal(vessel.name, 'SEA HORSE');
});

test('tracks multiple vessels independently', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000));
  applyReport(state, report('222', 1000));
  applyReport(state, report('111', 2000));
  assert.equal(allVessels(state).length, 2);
  assert.equal(getTrack(state, '111').points.length, 2);
  assert.equal(getTrack(state, '222').points.length, 1);
});

test('pruneStale removes vessels unheard from beyond the window', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000));
  applyReport(state, report('222', 500000));
  const removed = pruneStale(state, 600000, 200000);
  assert.equal(removed, 1);
  assert.equal(allVessels(state).length, 1);
  assert.equal(allVessels(state)[0].mmsi, '222');
  assert.equal(getTrack(state, '111'), null, 'the track goes with the vessel');
});

test('getTrack returns null for an unknown vessel', () => {
  assert.equal(getTrack(createVesselState(), 'nope'), null);
});

test('getObservedNames records the first name seen for a vessel', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000, { name: 'SEA HORSE' }));
  assert.deepEqual(getObservedNames(state, '111'), [{ name: 'SEA HORSE', timestamp_ms: 1000 }]);
});

test('getObservedNames appends only when the reported name actually changes', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000, { name: 'SEA HORSE' }));
  applyReport(state, report('111', 2000, { name: 'SEA HORSE' }));
  applyReport(state, report('111', 3000, { name: 'BLUE MARLIN' }));
  assert.deepEqual(getObservedNames(state, '111'), [
    { name: 'SEA HORSE', timestamp_ms: 1000 },
    { name: 'BLUE MARLIN', timestamp_ms: 3000 },
  ]);
});

test('getObservedNames is unaffected by a later report that omits the name', () => {
  const state = createVesselState();
  applyReport(state, report('111', 1000, { name: 'SEA HORSE' }));
  applyReport(state, report('111', 2000, { name: undefined }));
  assert.deepEqual(getObservedNames(state, '111'), [{ name: 'SEA HORSE', timestamp_ms: 1000 }]);
});

test('getObservedNames returns an empty array for an unknown vessel', () => {
  assert.deepEqual(getObservedNames(createVesselState(), 'nope'), []);
});

test('recordObservedName feeds the same history a ShipStaticData frame would carry', () => {
  // A static report carries identity but no position, so it never goes
  // through applyReport's point-push path — it must still show up here.
  const state = createVesselState();
  applyReport(state, report('111', 1000, { name: 'SEA HORSE' }));
  recordObservedName(state, '111', 'BLUE MARLIN', 4000);
  assert.deepEqual(getObservedNames(state, '111'), [
    { name: 'SEA HORSE', timestamp_ms: 1000 },
    { name: 'BLUE MARLIN', timestamp_ms: 4000 },
  ]);
});

test('recordObservedName is a safe no-op for a vessel with no track yet', () => {
  const state = createVesselState();
  recordObservedName(state, 'nope', 'GHOST SHIP', 1000);
  assert.deepEqual(getObservedNames(state, 'nope'), []);
});
