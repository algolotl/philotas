import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectContact, projectPosition, measureProjectionError } from '../lib/projection.js';
import { haversineMetres } from '../lib/geo.js';

const CIRCULAR_QUAY = [151.2108, -33.8610];

const contact = (overrides = {}) => ({
  position: CIRCULAR_QUAY,
  last_report_ms: 1_000_000,
  speed_over_ground_knots: 12,
  course_over_ground_degrees: 90, // due east
  ...overrides,
});

test('projects a moving contact forward along its course', () => {
  // 12 knots for 60s is ~370m.
  const p = projectContact(contact(), 1_060_000);
  assert.ok(p, 'expected a projection');
  assert.equal(p.projected, true);
  const moved = haversineMetres(CIRCULAR_QUAY, p.position);
  assert.ok(moved > 340 && moved < 400, `expected ~370m, got ${Math.round(moved)}m`);
  // Heading east: longitude increases, latitude barely moves.
  assert.ok(p.position[0] > CIRCULAR_QUAY[0]);
  assert.ok(Math.abs(p.position[1] - CIRCULAR_QUAY[1]) < 0.001);
});

test('refuses to project a stationary contact', () => {
  // A berthed vessel projected forward just jitters around the wharf.
  assert.equal(projectContact(contact({ speed_over_ground_knots: 0.2 }), 1_060_000), null);
});

test('refuses to project beyond the defensible horizon', () => {
  // After ten minutes a straight-line guess is no longer defensible; leaving
  // the contact where it was reported is the honest answer.
  assert.equal(projectContact(contact(), 1_000_000 + 11 * 60_000), null);
  assert.ok(projectContact(contact(), 1_000_000 + 9 * 60_000));
});

test('refuses to project without a course or a speed', () => {
  assert.equal(projectContact(contact({ course_over_ground_degrees: null }), 1_060_000), null);
  assert.equal(projectContact(contact({ speed_over_ground_knots: null }), 1_060_000), null);
});

test('refuses to project from a fix in the future', () => {
  // Negative elapsed time is a clock problem, not a projection opportunity.
  assert.equal(projectContact(contact(), 900_000), null);
});

test('uncertainty grows with distance run', () => {
  const near = projectContact(contact(), 1_030_000);
  const far = projectContact(contact(), 1_300_000);
  assert.ok(far.uncertainty_metres > near.uncertainty_metres);
  assert.ok(near.uncertainty_metres >= 25, 'a floor applies for immediate error');
});

test('marks the projection and keeps the reported position', () => {
  // The UI has to be able to tell a guess from a report. Losing the original
  // fix would make that impossible.
  const p = projectContact(contact(), 1_060_000);
  assert.deepEqual(p.projected_from, CIRCULAR_QUAY);
  assert.equal(p.projected, true);
  assert.ok(p.projected_metres > 0);
});

test('projectPosition returns GeoJSON order', () => {
  const [lon, lat] = projectPosition(CIRCULAR_QUAY, 90, 1000);
  assert.ok(lon > 150 && lon < 152, `longitude first, got ${lon}`);
  assert.ok(lat > -35 && lat < -33, `latitude second, got ${lat}`);
});

// ---------------------------------------------------------------- measurement

test('measures near-zero error on a perfectly straight track', () => {
  // A vessel holding course and speed is the best case: dead reckoning should
  // land essentially on top of the truth, which proves the arithmetic before
  // it is trusted on messier data.
  const points = [];
  let position = CIRCULAR_QUAY;
  for (let i = 0; i < 8; i += 1) {
    points.push({
      timestamp_ms: 1_000_000 + i * 30_000,
      position,
      speed_over_ground_knots: 12,
      course_over_ground_degrees: 90,
    });
    position = projectPosition(position, 90, 12 * 0.514444 * 30);
  }
  const stats = measureProjectionError({ points });
  assert.ok(stats.samples >= 6, `expected samples, got ${stats.samples}`);
  assert.ok(stats.median_error_metres < 5, `expected <5m, got ${stats.median_error_metres}m`);
});

test('reports large error when the vessel turns', () => {
  // Dead reckoning cannot see a turn coming. The measurement must show that
  // honestly rather than flattering the projection.
  const points = [
    { timestamp_ms: 0, position: CIRCULAR_QUAY, speed_over_ground_knots: 12, course_over_ground_degrees: 90 },
    { timestamp_ms: 120_000, position: projectPosition(CIRCULAR_QUAY, 180, 740), speed_over_ground_knots: 12, course_over_ground_degrees: 180 },
  ];
  const stats = measureProjectionError({ points });
  assert.equal(stats.samples, 1);
  assert.ok(stats.median_error_metres > 500, `a 90-degree turn should show up, got ${stats.median_error_metres}m`);
});

test('returns an empty result rather than throwing on an unusable track', () => {
  assert.equal(measureProjectionError({ points: [] }).samples, 0);
  assert.equal(measureProjectionError({}).samples, 0);
  assert.equal(measureProjectionError({ points: [{ timestamp_ms: 1, position: CIRCULAR_QUAY }] }).samples, 0);
});
