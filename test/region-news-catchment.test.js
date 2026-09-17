import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// lib/regions.js reaches lib/data/sample-lake/facilities.json through
// lib/config.js, imported without an import attribute. Same loader shim, and
// for the same reason, as test/poller-reaping.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

const { REGIONS, place, NEWS_CATCHMENT_MULTIPLE, NEWS_CATCHMENT_TYPES } = await import('../lib/regions.js');
const { fetchNews, _resetRefreshGate } = await import('../lib/feeds/news.js');
const newsStore = await import('../lib/corpus/news-store.js');

const contains = (outer, inner) =>
  outer.west <= inner.west && outer.east >= inner.east &&
  outer.south <= inner.south && outer.north >= inner.north;

// place()-built regions that carry a catchment: everything in REGIONS except
// world, sydney and canberra, which are hand-written and keep their own bbox.
// Measured 2026-08-17: 80 of 83. Written as an exact count rather than a floor,
// because a floor set at the population of an earlier catalogue is a floor that
// tolerates most of the current one silently losing its catchment — this was 16
// while 80 regions carried one, which would have let 64 of them go quiet.
const CATCHMENT_REGIONS = 80;

test('every news catchment contains the map bounding box it belongs to', () => {
  let checked = 0;
  for (const region of Object.values(REGIONS)) {
    if (!region.newsBbox) continue;
    checked++;
    assert.ok(region.bbox, `${region.id} has a newsBbox but no bbox`);
    assert.ok(contains(region.newsBbox, region.bbox),
      `${region.id}: news catchment ${JSON.stringify(region.newsBbox)} does not contain map bbox ${JSON.stringify(region.bbox)}`);
  }
  // Without this count, deleting newsBbox from place() entirely would make
  // every region skip the loop body and the test would report success having
  // asserted nothing.
  assert.equal(checked, CATCHMENT_REGIONS,
    `${checked} regions carried a news catchment to check; expected ${CATCHMENT_REGIONS}`);
});

test('the news catchment is three times the map half-extent', () => {
  assert.equal(NEWS_CATCHMENT_MULTIPLE, 3);
  const probe = place({ id: 'probe', name: 'Probe', center: [10, 20], half: [0.6, 0.5], theatre: 'Europe' });
  assert.equal(probe.theatre, 'Europe', 'theatre must pass through place() into the returned region');

  // 0.6 has no exact binary representation, so 10.6 - 9.4 lands on
  // 1.1999999999999993 rather than 1.2, and 0.6 * 3 lands on
  // 1.7999999999999998 rather than 1.8 — float artifacts of the inputs, not
  // of the catchment logic. assert.ok + Math.abs keeps these two checks
  // meaningful without asserting an exact bit pattern. The height check below
  // has no such artifact (20 +/- 1.5 is exact in binary, unlike 20 +/- 0.6),
  // so it stays a strict assert.equal — no reason to loosen a check that
  // cannot spuriously fail.
  const bboxWidth = probe.bbox.east - probe.bbox.west;
  const catchmentWidth = probe.newsBbox.east - probe.newsBbox.west;
  assert.ok(Math.abs(bboxWidth - 1.2) < 1e-9, `map bbox width was ${bboxWidth}, expected ~1.2`);
  assert.ok(Math.abs(catchmentWidth - 3.6) < 1e-9, `news catchment width was ${catchmentWidth}, expected ~3.6`);
  assert.equal(probe.newsBbox.north - probe.newsBbox.south, 3, 'news catchment height should be exactly 3');
});

test('the multiple applies at the scale it was measured at, and nowhere else', () => {
  assert.deepEqual([...NEWS_CATCHMENT_TYPES], ['city', 'strait']);

  // Same centre, same half-extent, four types. Only the metro-scale two widen.
  const half = [30, 16];
  const boxes = Object.fromEntries(['city', 'strait', 'country', 'region'].map((type) => [
    type, place({ id: `scale-${type}`, name: `Scale ${type}`, type, center: [-98, 39], half, theatre: 'United States' }),
  ]));
  for (const type of ['city', 'strait']) {
    assert.equal(boxes[type].newsBbox.east - boxes[type].newsBbox.west, 60 * NEWS_CATCHMENT_MULTIPLE,
      `${type} is metro scale and takes the measured multiple`);
  }
  for (const type of ['country', 'region']) {
    assert.deepEqual(boxes[type].newsBbox, boxes[type].bbox,
      `${type} is a wide view and is its own catchment — the multiple was never scored at this scale`);
  }
});

test('the three continental views filter news on their own map box', () => {
  // Every one of the 64 probe candidates the 3x was scored against is a city or
  // a chokepoint, at a half-extent of [0.6, 0.5] or [1.2, 1.0]. These three are
  // one to two orders of magnitude wider and were never scored.
  for (const id of ['unitedstates', 'australia', 'southpacific']) {
    assert.deepEqual(REGIONS[id].newsBbox, REGIONS[id].bbox,
      `${id} must take its own map box as its news catchment`);
  }

  // What the multiple did to the widest of them, and why it matters: the feed
  // serves the 60 NEWEST records inside the box (lib/feeds/news.js), sorted by
  // date and not by relevance, so a box reaching into another continent can win
  // the layer outright. Measured 2026-08-17 at 3x on unitedstates' half of
  // [30, 16]: lon -188..-8, lat -9..87.
  const inside = (b, [lon, lat]) => b.west <= lon && b.east >= lon && b.south <= lat && b.north >= lat;
  const foreign = { 'Mexico City': [-99.1, 19.4], 'Bogota': [-74.0, 4.7], 'Nuuk': [-51.7, 64.2] };
  for (const [name, coord] of Object.entries(foreign)) {
    assert.equal(inside(REGIONS.unitedstates.newsBbox, coord), false,
      `${name} is inside the united states news catchment`);
  }
  // And the test is not vacuous: the catchment still catches the country.
  for (const [name, coord] of Object.entries({ Kansas: [-98, 39], Seattle: [-122.3, 47.6], Miami: [-80.2, 25.8] })) {
    assert.equal(inside(REGIONS.unitedstates.newsBbox, coord), true,
      `${name} is outside the united states news catchment`);
  }
});

test('an explicit newsHalf overrides the computed 3x catchment', () => {
  // No caller in this repo passes newsHalf today, but place() accepts it
  // (brief:15) and an accepted-but-unexercised parameter is untested code on
  // arrival. half is left at the metro default so the computed fallback
  // (1.8 x 1.5) is visibly different from what newsHalf asks for (10 x 8) —
  // a regression that silently ignored newsHalf would not pass by coincidence.
  const probe = place({ id: 'newshalf-probe', name: 'NewsHalfProbe', center: [10, 20], half: [0.6, 0.5], newsHalf: [5, 4], theatre: 'Europe' });
  assert.equal(probe.newsBbox.east - probe.newsBbox.west, 10, 'newsHalf width should override the computed 3x catchment');
  assert.equal(probe.newsBbox.north - probe.newsBbox.south, 8, 'newsHalf height should override the computed 3x catchment');
  assert.ok(contains(probe.newsBbox, probe.bbox), 'an explicit newsHalf must still contain the map bbox it was given');
});

test('a news catchment never reaches past a pole', () => {
  const arctic = place({ id: 'arctic', name: 'Arctic', center: [15, 78], half: [0.6, 5], theatre: 'Europe' });
  assert.equal(arctic.newsBbox.north, 90, 'north clamp should stop exactly at the pole');
  assert.ok(contains(arctic.newsBbox, arctic.bbox), 'still contains its own map box after the north clamp');

  // arctic's own unclamped south (78 - 5*3 = 63) never reaches -90, so it only
  // ever exercises the north half of clampLatitude. Nothing shipped drives
  // either branch: measured 2026-08-17 across all 80 real catchments, the
  // lowest south is -43 (australia) and the highest north is 62.7181
  // (anchorage), both a long way inside the poles. Confining the multiple to
  // metro scale took the extremes further in, not out — before it, unitedstates
  // reached 87 north and southpacific -84 south. So these two probes are the
  // only thing exercising the clamp at all, in both directions: deleting
  // `Math.max(-90, ...)` left the whole suite green until the south one was
  // added. -78 - 5*3 = -93, past the pole, so this one does drive it.
  const antarctic = place({ id: 'antarctic', name: 'Antarctic', center: [0, -78], half: [0.6, 5], theatre: 'Europe' });
  assert.equal(antarctic.newsBbox.south, -90, 'south clamp should stop exactly at the pole');
  assert.ok(contains(antarctic.newsBbox, antarctic.bbox), 'still contains its own map box after the south clamp');
});

test('hand-tuned regions keep their own bbox as their news catchment', () => {
  // sydney, canberra and world are hand-written and are NOT widened. The news
  // feed falls back to `bbox` when `newsBbox` is absent, so absence is the
  // signal rather than a copy of the same numbers.
  for (const id of ['world', 'sydney', 'canberra']) {
    assert.equal(REGIONS[id].newsBbox, undefined, `${id} must not carry a widened catchment`);
  }
});

test('the news feed filters on the catchment, not on the map box', async () => {
  newsStore._reset();
  _resetRefreshGate();

  const region = place({ id: 'catchtest', name: 'Catchtest', center: [0, 0], half: [0.6, 0.5], theatre: 'Europe' });
  const now = Date.now();
  // Sits outside the 0.6x0.5 map box and inside the 1.8x1.5 catchment. This is
  // the Le Havre case — 0 records at the map box, 21 at the wide one in run 2 —
  // where the story is filed against a neighbouring place.
  const record = {
    id: 'gkg-outside-map-box', dateMs: now, title: 'Filed next door',
    source: 'example.com', url: 'https://example.com/a', tone: 0,
    organisations: [], locations: [{ lon: 1.2, lat: 0.9, name: 'Neighbour' }],
  };

  const fc = await fetchNews(region, { refresh: async () => newsStore.ingest([record], now), now });
  assert.equal(fc.features.length, 1, 'record inside the catchment must be served');
  assert.equal(fc.features[0].properties.placed_at, 'Neighbour');
});

test('no region carries a dead news mode parameter, and only world carries a news query', () => {
  // `mode` died with the DOC API: nothing reads it anywhere. `query` is alive
  // again — lib/feeds/news.js narrows a region's news window to stories whose
  // text matches its OR-list of topics — and world is the only region that
  // carries one, so the filter engages nowhere except the world view.
  let queried = 0;
  for (const region of Object.values(REGIONS)) {
    assert.equal(region.params?.news?.mode, undefined,
      `${region.id} still carries params.news.mode — it died with the DOC API`);
    if (region.params?.news?.query !== undefined) queried += 1;
  }
  assert.equal(queried, 1, 'exactly one region (world) carries a news query');
  assert.equal(
    REGIONS.world.params?.news?.query,
    '(earthquake OR election OR conflict OR flood OR wildfire OR summit OR protest)',
    'world carries the curated topical OR-list'
  );
});
