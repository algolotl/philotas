import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectDeviation } from '../src/detectors/deviation.js';

const ferry = JSON.parse(readFileSync(new URL('./fixtures/ferry-track.json', import.meta.url)));

const point = (timestamp_ms, course_over_ground_degrees, overrides = {}) => ({
  timestamp_ms,
  position: [151.34, -33.95],
  speed_over_ground_knots: 10,
  course_over_ground_degrees,
  ...overrides,
});

// Steady 090 for four reports, then a hard turn to 200 held for four more.
const turning = {
  mmsi: '111222333',
  name: 'TEST TURNER',
  points: [
    point(100000, 90), point(160000, 92), point(220000, 89), point(280000, 91),
    point(340000, 198), point(400000, 202), point(460000, 199), point(520000, 201),
  ],
};

test('fires on a sustained course change', () => {
  const event = detectDeviation(turning, 520000);
  assert.ok(event, 'expected a deviation event');
  assert.equal(event.type, 'course_deviation');
  assert.ok(event.turn_degrees > 90, `expected a large turn, got ${event.turn_degrees}`);
  assert.equal(event.mmsi, '111222333');
});

test('does not fire on a steady course', () => {
  const steady = {
    mmsi: '777',
    points: Array.from({ length: 8 }, (_, i) => point(i * 60000, 90 + (i % 3) - 1)),
  };
  assert.equal(detectDeviation(steady, 420000), null);
});

test('does not fire on a momentary wobble', () => {
  // Eight reports so the window guard cannot short-circuit this: one bad
  // heading among four must not outvote the other three.
  const wobble = {
    mmsi: '444',
    points: [
      point(100000, 90), point(160000, 92), point(220000, 89), point(280000, 91),
      point(340000, 190), point(400000, 91), point(460000, 90), point(520000, 92),
    ],
  };
  assert.equal(detectDeviation(wobble, 520000), null);
});

test('handles the 0/360 wrap without a false positive', () => {
  // Naive arithmetic averaging makes 359 and 1 average to 180, which would
  // report a vessel crossing north as a U-turn.
  const acrossNorth = {
    mmsi: '555',
    points: [
      point(100000, 355), point(160000, 358), point(220000, 2), point(280000, 5),
      point(340000, 3), point(400000, 1), point(460000, 359), point(520000, 357),
    ],
  };
  assert.equal(detectDeviation(acrossNorth, 520000), null, 'crossing north is not a turn');
});

test('ignores course over ground for a stopped vessel', () => {
  // A drifting vessel reports meaningless heading, which would otherwise look
  // like violent manoeuvring.
  const drifting = {
    mmsi: '666',
    points: [
      point(100000, 10, { speed_over_ground_knots: 0.2 }),
      point(160000, 200, { speed_over_ground_knots: 0.1 }),
      point(220000, 80, { speed_over_ground_knots: 0.3 }),
      point(280000, 300, { speed_over_ground_knots: 0.2 }),
      point(340000, 150, { speed_over_ground_knots: 0.1 }),
      point(400000, 20, { speed_over_ground_knots: 0.2 }),
      point(460000, 250, { speed_over_ground_knots: 0.1 }),
      point(520000, 95, { speed_over_ground_knots: 0.2 }),
    ],
  };
  assert.equal(detectDeviation(drifting, 520000), null);
});

test('carries the numbers that triggered it', () => {
  const event = detectDeviation(turning, 520000);
  assert.match(event.evidence, /sustained over 4 reports/);
  assert.ok(event.previous_course_degrees >= 88 && event.previous_course_degrees <= 93);
  assert.ok(event.current_course_degrees >= 197 && event.current_course_degrees <= 203);
});

test('returns null without two full windows of history', () => {
  assert.equal(detectDeviation(ferry, ferry.points.at(-1).timestamp_ms), null);
});

test('stamps a stable started_at_ms, not a fresh now, so dedup ids hold', () => {
  // The turn is visible from the first report of the recent window. The same
  // detector run at a later `now` must produce the SAME started_at_ms — that
  // is what keeps recordEvent's id (`type:mmsi:started_at_ms`) from changing
  // every 30 s pass and filling the table with duplicates.
  const atTurn = detectDeviation(turning, 520000);
  const later = detectDeviation(turning, 700000);
  assert.ok(atTurn && later, 'both calls should fire');
  assert.equal(atTurn.started_at_ms, later.started_at_ms);
  assert.equal(atTurn.started_at_ms, 100000); // the oldest report in the window
});

test('a departure from standstill is not a course deviation', () => {
  // The vessel sat still (noise COG) during the previous window, then got under
  // way on the reciprocal course. The old minimum-speed gate looked only at the
  // recent window, so the noise in the previous window read as a violent turn.
  const underWay = {
    mmsi: '888',
    points: [
      point(100000, 0, { speed_over_ground_knots: 0.1 }),
      point(160000, 359, { speed_over_ground_knots: 0.0 }),
      point(220000, 1, { speed_over_ground_knots: 0.1 }),
      point(280000, 0, { speed_over_ground_knots: 0.0 }),
      point(340000, 180, { speed_over_ground_knots: 8 }),
      point(400000, 182, { speed_over_ground_knots: 9 }),
      point(460000, 179, { speed_over_ground_knots: 9 }),
      point(520000, 181, { speed_over_ground_knots: 10 }),
    ],
  };
  assert.equal(detectDeviation(underWay, 520000), null);
});

test('never reads points after now', () => {
  // Evaluated before the turn begins, only steady headings are visible.
  assert.equal(detectDeviation(turning, 280000), null);
});
