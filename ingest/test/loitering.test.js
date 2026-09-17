import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectLoitering } from '../src/detectors/loitering.js';

const loiterer = JSON.parse(readFileSync(new URL('./fixtures/loiter-track.json', import.meta.url)));
const ferry = JSON.parse(readFileSync(new URL('./fixtures/ferry-track.json', import.meta.url)));

const NO_BERTHS = [];
const BERTH_AT_LOITER_SPOT = [
  { id: 'test-berth', name: 'Test Berth', position: [151.2612, -33.8322], radius_metres: 300 },
];

test('fires when a vessel holds near-stationary in open water', () => {
  const now = loiterer.points.at(-1).timestamp_ms;
  const event = detectLoitering(loiterer, now, { berths: NO_BERTHS });
  assert.ok(event, 'expected a loitering event');
  assert.equal(event.type, 'loitering');
  assert.equal(event.mmsi, '636019999');
  assert.ok(event.duration_ms >= 20 * 60 * 1000);
});

test('does not fire when the vessel is stationary inside a berth', () => {
  // Stationary at a berth is a vessel doing its job. The berth list is what
  // separates that from stationary in a channel.
  const now = loiterer.points.at(-1).timestamp_ms;
  assert.equal(detectLoitering(loiterer, now, { berths: BERTH_AT_LOITER_SPOT }), null);
});

test('does not fire for a vessel under way', () => {
  const now = ferry.points.at(-1).timestamp_ms;
  assert.equal(detectLoitering(ferry, now, { berths: NO_BERTHS }), null);
});

test('does not fire when the slow run has ended', () => {
  // The vessel loitered, then got under way again. That is a past event, not a
  // current condition, so it must not be reported as one.
  const departed = {
    mmsi: loiterer.mmsi,
    name: loiterer.name,
    points: [
      ...loiterer.points,
      { timestamp_ms: 4800000, position: [151.2700, -33.8400], speed_over_ground_knots: 9.5, course_over_ground_degrees: 120 },
    ],
  };
  assert.equal(detectLoitering(departed, 4800000, { berths: NO_BERTHS }), null);
});

test('does not fire when the vessel drifts too far to be holding position', () => {
  // Slow but steadily moving is a vessel making way, not one holding station.
  const drifting = {
    mmsi: '999',
    points: [
      { timestamp_ms: 0, position: [151.20, -33.85], speed_over_ground_knots: 0.9, course_over_ground_degrees: 90 },
      { timestamp_ms: 600000, position: [151.22, -33.85], speed_over_ground_knots: 0.9, course_over_ground_degrees: 90 },
      { timestamp_ms: 1200000, position: [151.24, -33.85], speed_over_ground_knots: 0.9, course_over_ground_degrees: 90 },
      { timestamp_ms: 1800000, position: [151.26, -33.85], speed_over_ground_knots: 0.9, course_over_ground_degrees: 90 },
    ],
  };
  assert.equal(detectLoitering(drifting, 1800000, { berths: NO_BERTHS }), null);
});

test('carries the numbers that triggered it', () => {
  const now = loiterer.points.at(-1).timestamp_ms;
  const event = detectLoitering(loiterer, now, { berths: NO_BERTHS });
  assert.match(event.evidence, /20min/);
  assert.match(event.evidence, /outside any known berth/);
  assert.ok(event.drift_metres < 500);
  assert.equal(event.report_count, 5);
});

test('never reads points after now', () => {
  // Evaluated one point into the slow run, the duration is too short to fire —
  // the later points that would qualify it must be invisible.
  const now = loiterer.points[2].timestamp_ms;
  assert.equal(detectLoitering(loiterer, now, { berths: NO_BERTHS }), null);
});
