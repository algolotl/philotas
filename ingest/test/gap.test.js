import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectGap } from '../src/detectors/gap.js';

const ferry = JSON.parse(readFileSync(new URL('./fixtures/ferry-track.json', import.meta.url)));
const carrier = JSON.parse(readFileSync(new URL('./fixtures/carrier-gap.json', import.meta.url)));

test('no event while a vessel is reporting on cadence', () => {
  const lastTimestamp = ferry.points.at(-1).timestamp_ms;
  // 30 seconds after the last report, on a 30s baseline: nothing wrong.
  assert.equal(detectGap(ferry, lastTimestamp + 30000), null);
});

test('fires once elapsed time exceeds the per-vessel threshold', () => {
  const lastTimestamp = carrier.points.at(-1).timestamp_ms;
  // Baseline is 120s; default factor 6 and floor 5min give a 12min threshold.
  const event = detectGap(carrier, lastTimestamp + 13 * 60 * 1000);
  assert.ok(event, 'expected a gap event');
  assert.equal(event.type, 'ais_gap');
  assert.equal(event.mmsi, '477999888');
  assert.equal(event.baseline_interval_ms, 120000);
  assert.equal(event.threshold_ms, 720000);
});

test('threshold scales with the vessel, not a global constant', () => {
  // The same silence against the ferry's 30s baseline is far more anomalous,
  // so it must also fire — but with a much tighter threshold.
  const ferryEvent = detectGap(ferry, ferry.points.at(-1).timestamp_ms + 13 * 60 * 1000);
  const carrierEvent = detectGap(carrier, carrier.points.at(-1).timestamp_ms + 13 * 60 * 1000);
  assert.ok(ferryEvent && carrierEvent);
  assert.ok(
    ferryEvent.threshold_ms < carrierEvent.threshold_ms,
    'a dense reporter must have a tighter threshold'
  );
});

test('carries the numbers that triggered it', () => {
  const event = detectGap(carrier, carrier.points.at(-1).timestamp_ms + 13 * 60 * 1000);
  assert.match(event.evidence, /13min/);
  assert.match(event.evidence, /120s observed median/);
  assert.equal(event.last_report_ms, 2480000);
  assert.equal(event.last_speed_knots, 9);
  assert.equal(event.last_course_degrees, 90);
});

test('projects a position forward along the last known course', () => {
  const lastTimestamp = carrier.points.at(-1).timestamp_ms;
  const event = detectGap(carrier, lastTimestamp + 60 * 60 * 1000);
  // Heading 090 for an hour at 9 knots: longitude increases, latitude holds.
  assert.ok(event.projected_position[0] > event.last_position[0]);
  assert.ok(Math.abs(event.projected_position[1] - event.last_position[1]) < 0.05);
  assert.ok(event.projected_radius_metres > 0);
});

test('uncertainty grows with elapsed time', () => {
  const lastTimestamp = carrier.points.at(-1).timestamp_ms;
  const shorter = detectGap(carrier, lastTimestamp + 20 * 60 * 1000);
  const longer = detectGap(carrier, lastTimestamp + 90 * 60 * 1000);
  assert.ok(longer.projected_radius_metres > shorter.projected_radius_metres);
});

test('returns null without enough history to form a baseline', () => {
  const thin = { mmsi: '1', points: carrier.points.slice(0, 2) };
  assert.equal(detectGap(thin, 9999999999), null);
});

test('never reads points after now', () => {
  // Evaluate just after the 4th report — enough points for a baseline, so this
  // exercises the lookahead rule rather than the insufficient-history guard.
  // The 5th point exists in the fixture and must be invisible.
  const evaluateAt = carrier.points[3].timestamp_ms + 1000;
  assert.equal(
    detectGap(carrier, evaluateAt),
    null,
    'on cadence at that instant — seeing later points must not change this'
  );
});

test('a gap is judged from the last visible point, not the last point in the array', () => {
  // Four reports on cadence, then a report far in the future. Evaluated inside
  // the hole, the future report must be invisible. A detector that ignored
  // `now` would measure from the last array element, compute a negative
  // elapsed time, and report nothing at all.
  const withFutureReport = {
    mmsi: carrier.mmsi,
    name: carrier.name,
    points: [
      ...carrier.points.slice(0, 4),
      { timestamp_ms: 9000000, position: [151.8, -33.95], speed_over_ground_knots: 9, course_over_ground_degrees: 90 },
    ],
  };
  const lastVisible = carrier.points[3];
  const evaluateAt = lastVisible.timestamp_ms + 13 * 60 * 1000;

  const event = detectGap(withFutureReport, evaluateAt);
  assert.ok(event, 'expected a gap event measured from the last visible fix');
  assert.equal(event.last_report_ms, lastVisible.timestamp_ms);
  assert.deepEqual(event.last_position, lastVisible.position);
});
