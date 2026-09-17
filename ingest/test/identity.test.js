import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIdentityAnomaly } from '../src/detectors/identity.js';

const track = {
  mmsi: '503999111',
  name: 'TEST VESSEL',
  points: [
    { timestamp_ms: 1000, position: [151.21, -33.86], speed_over_ground_knots: 5, course_over_ground_degrees: 90 },
  ],
};

test('does not fire for a well-formed MMSI with a stable name', () => {
  const observedNames = [{ name: 'TEST VESSEL', timestamp_ms: 1000 }];
  assert.equal(detectIdentityAnomaly(track, 2000, { observedNames }), null);
});

test('does not fire with no observed-names history at all', () => {
  assert.equal(detectIdentityAnomaly(track, 2000, {}), null);
});

test('fires when the MMSI is not 9 digits', () => {
  const shortMmsi = { ...track, mmsi: '12345' };
  const event = detectIdentityAnomaly(shortMmsi, 2000, {});
  assert.ok(event, 'expected an identity anomaly event');
  assert.equal(event.type, 'identity_anomaly');
  assert.equal(event.mmsi, '12345');
  assert.match(event.evidence, /not 9 digits/);
});

test('fires when the MID (first three digits) is outside the valid maritime range', () => {
  // 000-200 is not an assigned maritime identification digit range.
  const badMid = { ...track, mmsi: '003999111' };
  const event = detectIdentityAnomaly(badMid, 2000, {});
  assert.ok(event, 'expected an identity anomaly event');
  assert.match(event.evidence, /MID/);
});

test('does not fire for a valid MID at the low end of the range', () => {
  const lowMid = { ...track, mmsi: '201999111' };
  assert.equal(detectIdentityAnomaly(lowMid, 2000, {}), null);
});

test('does not fire for a valid MID at the high end of the range', () => {
  const highMid = { ...track, mmsi: '775999111' };
  assert.equal(detectIdentityAnomaly(highMid, 2000, {}), null);
});

test('fires when the same MMSI reports two different names over time', () => {
  const observedNames = [
    { name: 'SEA HORSE', timestamp_ms: 1000 },
    { name: 'BLUE MARLIN', timestamp_ms: 5000 },
  ];
  const event = detectIdentityAnomaly(track, 6000, { observedNames });
  assert.ok(event, 'expected an identity anomaly event');
  assert.equal(event.type, 'identity_anomaly');
  assert.match(event.evidence, /SEA HORSE/);
  assert.match(event.evidence, /BLUE MARLIN/);
});

test('does not treat re-formatted spelling of the same name as an anomaly', () => {
  // "Sea Horse" vs "SEA   HORSE" is one identity typed inconsistently, not a
  // real change — case and whitespace must be normalised before comparing.
  const observedNames = [
    { name: 'Sea Horse', timestamp_ms: 1000 },
    { name: 'SEA   HORSE', timestamp_ms: 5000 },
  ];
  assert.equal(detectIdentityAnomaly(track, 6000, { observedNames }), null);
});

test('never reads a name observed after now', () => {
  const observedNames = [
    { name: 'SEA HORSE', timestamp_ms: 1000 },
    { name: 'BLUE MARLIN', timestamp_ms: 999999 },
  ];
  // Evaluated before the second name was ever reported — must not fire.
  assert.equal(detectIdentityAnomaly(track, 6000, { observedNames }), null);
});

test('stamps a stable started_at_ms so dedup ids do not change every pass', () => {
  // The ferry MMSIs in the real feed are 'TFNSW-...', which always fail the
  // 9-digit check — so this detector fires on every pass. recordEvent's id is
  // `${type}:${mmsi}:${started_at_ms}`; a fresh started_at_ms per pass would
  // insert a new row each time instead of updating the one open event.
  const event = detectIdentityAnomaly({ ...track, mmsi: '12345' }, 6000, {});
  assert.ok(event, 'expected an identity anomaly event');
  assert.equal(event.started_at_ms, 1000); // first visible point's timestamp
  assert.equal(event.started_at_ms, track.points[0].timestamp_ms);
});

test('carries both triggering conditions when MMSI format and name history both fire', () => {
  const badMmsiTrack = { ...track, mmsi: '12345' };
  const observedNames = [
    { name: 'SEA HORSE', timestamp_ms: 1000 },
    { name: 'BLUE MARLIN', timestamp_ms: 5000 },
  ];
  const event = detectIdentityAnomaly(badMmsiTrack, 6000, { observedNames });
  assert.ok(event);
  assert.match(event.evidence, /not 9 digits/);
  assert.match(event.evidence, /SEA HORSE/);
  assert.match(event.evidence, /BLUE MARLIN/);
});

test('attaches the last visible position when available', () => {
  const event = detectIdentityAnomaly({ ...track, mmsi: '12345' }, 2000, {});
  assert.deepEqual(event.position, track.points[0].position);
});

test('position is null when there is no visible track history', () => {
  const bare = { mmsi: '12345', points: [] };
  const event = detectIdentityAnomaly(bare, 2000, {});
  assert.equal(event.position, null);
});
