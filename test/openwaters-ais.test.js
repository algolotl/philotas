import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipTypeFromAisCode, toVessel, fetchOpenWatersVessels } from '../lib/feeds/openwaters-ais.js';

test('maps AIS ship-type codes to the layer categories', () => {
  assert.equal(shipTypeFromAisCode(70), 'cargo');
  assert.equal(shipTypeFromAisCode(79), 'cargo');
  assert.equal(shipTypeFromAisCode(80), 'tanker');
  assert.equal(shipTypeFromAisCode(89), 'tanker');
  assert.equal(shipTypeFromAisCode(60), 'passenger');
  assert.equal(shipTypeFromAisCode(35), 'naval');
  assert.equal(shipTypeFromAisCode(31), 'tug');
  assert.equal(shipTypeFromAisCode(52), 'tug');
  assert.equal(shipTypeFromAisCode(50), 'pilot');
  assert.equal(shipTypeFromAisCode(37), 'pleasure');
  assert.equal(shipTypeFromAisCode(undefined), 'unknown');
  assert.equal(shipTypeFromAisCode(99), 'unknown');
});

test('maps an aiscast feature to the vessel shape', () => {
  const f = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [56.25, 26.57] },
    properties: { mmsi: 538003467, name: 'KSL MINGYANG', type: 79, cog: 273.4, sog: 0, heading: 40, seen: '2026-09-19T10:22:31Z' },
  };
  const v = toVessel(f, 1_000_000);
  assert.equal(v.mmsi, 538003467);
  assert.equal(v.name, 'KSL MINGYANG');
  assert.equal(v.ship_type, 'cargo');
  assert.deepEqual(v.position, [56.25, 26.57]);
  assert.equal(v.speed_over_ground_knots, 0);
  assert.equal(v.course_over_ground_degrees, 273.4);
  assert.equal(v.last_report_ms, Date.parse('2026-09-19T10:22:31Z'));
  assert.equal(v.feed_source, 'aishub');
});

test('falls back to the fetch time when a vessel carries no timestamp', () => {
  const v = toVessel({ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { mmsi: 7 } }, 12345);
  assert.equal(v.last_report_ms, 12345);
  assert.equal(v.name, null);
});

test('drops a feature with no usable position', () => {
  assert.equal(toVessel({ type: 'Feature', geometry: { type: 'Point', coordinates: [] }, properties: { mmsi: 1 } }, 1), null);
  assert.equal(toVessel({ type: 'Feature', properties: { mmsi: 1 } }, 1), null);
});

test('fetches by the region bbox and maps the collection', async () => {
  let calledUrl = null;
  const fetchImpl = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [56.3, 26.5] }, properties: { mmsi: 2, name: 'A', type: 80, sog: 5, cog: 90, seen: '2026-09-19T10:00:00Z' } },
    ] }) };
  };
  const vessels = await fetchOpenWatersVessels({ bbox: { south: 25, west: 55, north: 27, east: 57 } }, { fetchImpl });
  assert.match(calledUrl, /bbox=25,55,27,57/);
  assert.equal(vessels.length, 1);
  assert.equal(vessels[0].mmsi, 2);
  assert.equal(vessels[0].ship_type, 'tanker');
});

test('returns nothing for a region with no bbox rather than querying the world', async () => {
  const vessels = await fetchOpenWatersVessels({}, { fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.deepEqual(vessels, []);
});

test('raises on a non-ok response so the layer can report an outage', async () => {
  await assert.rejects(
    () => fetchOpenWatersVessels({ bbox: { south: 25, west: 55, north: 27, east: 57 } }, { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /503/,
  );
});
