import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMetres, projectPosition, medianIntervalMs } from '../src/geo.js';

// Circular Quay -> Manly Wharf is a little under 10km great-circle.
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

test('projectPosition due north increases latitude and holds longitude', () => {
  const [lon, lat] = projectPosition(CIRCULAR_QUAY, 0, 1000);
  assert.ok(lat > CIRCULAR_QUAY[1], 'latitude should increase heading north');
  assert.ok(Math.abs(lon - CIRCULAR_QUAY[0]) < 1e-6, 'longitude should barely move');
});

test('projectPosition round-trips against haversineMetres', () => {
  const target = projectPosition(CIRCULAR_QUAY, 45, 5000);
  const back = haversineMetres(CIRCULAR_QUAY, target);
  assert.ok(Math.abs(back - 5000) < 1, `expected 5000m, got ${back}`);
});

test('projectPosition returns GeoJSON order, longitude first', () => {
  const [lon, lat] = projectPosition(CIRCULAR_QUAY, 90, 2000);
  // Sydney sits near 151E, -33S. Getting the order wrong is the classic bug.
  assert.ok(lon > 150 && lon < 152, `longitude should be ~151, got ${lon}`);
  assert.ok(lat > -35 && lat < -33, `latitude should be ~-33.8, got ${lat}`);
});

test('medianIntervalMs returns the median gap between timestamps', () => {
  // gaps: 1000, 1000, 5000, 1000 -> sorted 1000,1000,1000,5000 -> median 1000
  assert.equal(medianIntervalMs([0, 1000, 2000, 7000, 8000]), 1000);
});

test('medianIntervalMs averages the middle pair for an even count', () => {
  // gaps: 1000, 3000 -> median (1000+3000)/2 = 2000
  assert.equal(medianIntervalMs([0, 1000, 4000]), 2000);
});

test('medianIntervalMs returns null below two timestamps', () => {
  assert.equal(medianIntervalMs([]), null);
  assert.equal(medianIntervalMs([5]), null);
});
