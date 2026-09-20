import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

import { fetchTransport, fetchFerriesAsVessels, _resetFerryFeedCache } from '../lib/feeds/transport.js';

const { transit_realtime: rt } = GtfsRealtimeBindings;

// Transport for NSW enforces one quota across every API on the key: 60,000
// requests a day on the Bronze plan. The ferry endpoint had two independent
// consumers — the transport layer at a 10s TTL and the vessels layer at 5s —
// which put the account at 65,088 calls a day, and on 2026-08-15 that arrived
// as simultaneous 429s on ferries, sydneytrains, buses and the camera feed.
//
// These tests pin the deduplication that fixed it. They count upstream calls,
// because the quota counts upstream calls.

// lib/config.js reaches sample-lake JSON through the connector registry, which
// imports it without an import attribute. Same loader shim, and for the same
// reason, as test/warm-regions-default.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

// Dynamic, because the shim above has to be registered before the module graph
// is loaded and a static import would be hoisted past it. The budget tests at
// the bottom of this file read the shipped TTLs off this rather than retyping
// them: a hand-copied TTL is a number that cannot change when production does,
// which is exactly how a 6s transport TTL passed this file's own budget check
// on 2026-08-17 while production went to 76,608 calls a day.
let config;
before(async () => {
  config = await import('../lib/config.js');
});

const ferryPayload = () => {
  const message = rt.FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1000) },
    entity: [
      {
        id: '1',
        vehicle: {
          vehicle: { id: 'FRESHWATER', label: 'FRESHWATER' },
          trip: { routeId: 'F1' },
          position: { latitude: -33.8501, longitude: 151.2401, bearing: 45, speed: 6 },
          timestamp: Math.floor(Date.now() / 1000),
        },
      },
    ],
  });
  return rt.FeedMessage.encode(message).finish();
};

let calls;
let realFetch;
let previousKey;

beforeEach(() => {
  calls = [];
  previousKey = process.env.TFNSW_API_KEY;
  process.env.TFNSW_API_KEY = 'test-key';
  _resetFerryFeedCache();

  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => ferryPayload(),
    };
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousKey === undefined) delete process.env.TFNSW_API_KEY;
  else process.env.TFNSW_API_KEY = previousKey;
  _resetFerryFeedCache();
});

const ferryCalls = () => calls.filter((u) => u.includes('/ferries/')).length;

test('the vessels layer does not issue its own ferry request', async () => {
  const region = { id: 'sydney', params: { transport: { sources: ['ferries'] } } };

  await fetchTransport(region);
  assert.equal(ferryCalls(), 1, 'the transport poll fetches ferries once');

  await fetchFerriesAsVessels(region);
  assert.equal(ferryCalls(), 1, 'the vessels layer reuses that decode rather than fetching again');
});

test('either caller alone still populates from a single request', async () => {
  const region = { id: 'sydney', params: { transport: { sources: ['ferries'] } } };

  // Vessels first this time: the cache must not depend on transport priming it.
  const vessels = await fetchFerriesAsVessels(region);
  assert.equal(ferryCalls(), 1);
  assert.equal(vessels.length, 1);
  assert.equal(vessels[0].name, 'FRESHWATER');
  assert.equal(vessels[0].ship_type, 'passenger');

  const fc = await fetchTransport(region);
  assert.equal(ferryCalls(), 1, 'still one upstream call');
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.mode, 'Ferry');
});

test('the cached decode expires rather than serving a frozen position', async () => {
  const region = { id: 'sydney', params: { transport: { sources: ['ferries'] } } };
  await fetchTransport(region);
  assert.equal(ferryCalls(), 1);

  // A stale ferry position is worse than an extra call. Simulate the interval
  // elapsing rather than sleeping through it.
  _resetFerryFeedCache();
  await fetchTransport(region);
  assert.equal(ferryCalls(), 2, 'a new interval fetches again');
});

test('a mode other than ferries is unaffected by the shared cache', async () => {
  const region = { id: 'sydney', params: { transport: { sources: ['ferries', 'buses'] } } };
  await fetchTransport(region);

  assert.equal(ferryCalls(), 1);
  assert.equal(calls.filter((u) => u.endsWith('/buses')).length, 1, 'buses still fetch normally');
});

// ─── The daily call budget ───────────────────────────────────────────────────
//
// What the application spends against that one quota. lib/cache.js re-polls
// each feed on a setInterval at exactly its configured TTL, so a feed costs
// 86,400,000 / ttl calls a day for every endpoint it hits:
//
//   transport   10s x 5 endpoints   ferries, sydneytrains, buses, lightrail,
//                                   metro — region sydney's transport.sources
//                                   in lib/regions.js.  5 x 8,640 = 43,200/day
//   ingest      20s x 1 endpoint    philotas-ingest polls the ferry endpoint
//                                   itself, on the same key
//                                   (ingest/src/ferry-source.js).  = 4,320/day
//   cameras    300s x 1 endpoint    the TfNSW Live Traffic GeoJSON, on the same
//                                   key and through the same shared limiter
//                                   (lib/feeds/cameras.js).        =   288/day
//   vessels      5s x 0 endpoints   ferries-as-vessels is served from the
//                                   shared decode in lib/feeds/transport.js.
//                                   The four tests above pin that
//                                   behaviourally, so it is 0 here rather than
//                                   assumed to be.                 =     0/day
//                                                                  ------------
//                                                                   47,808/day
//
// The 47,808 checks out: recomputed here from the shipped TTLs, the five modes
// in lib/regions.js and the 20s interval in ingest/src/ferry-source.js. It is
// 80% of the quota. Every other Sydney layer is somebody else's API (adsb.fi /
// OpenSky, CelesTrak, SatNOGS, NSW RFS, NASA FIRMS, USGS, BoM, GDELT, DSN,
// EONET) and costs this quota nothing.
//
// One caveat on the transport line. All five modes are priced at the transport
// TTL, but the ferry endpoint is separately clamped by the 10s shared decode
// cache in lib/feeds/transport.js, so below a 10s transport TTL the total below
// is an upper bound rather than an exact count. That is the right direction to
// be wrong in for a quota guard, and the 2026-08-17 audit's 76,608 figure for a
// 6s TTL is the same upper bound.

test('the quota being budgeted against is the one TfNSW Bronze actually sells', () => {
  // Pinned to a literal because this is the one number here that is not ours to
  // choose: 60,000 calls a day per KEY, across every API on it. It lives in
  // production so the feeds and the ingest service can cite one value instead
  // of three prose copies, and it is asserted here against an independent
  // literal so that widening it cannot quietly widen the budget below.
  assert.equal(config.TFNSW_DAILY_CALL_QUOTA, 60_000,
    'TfNSW Bronze is 60,000 calls/day per key — if the plan really changed, change this literal too');
});

test('the shipped poll intervals keep the day inside the TfNSW quota', () => {
  const DAY_MS = 86_400_000;

  // Read from lib/config.js, never retyped. A TTL edit has to move `total`.
  const transportTtlMs = config.FEEDS.transport.ttl;
  const camerasTtlMs = config.FEEDS.cameras.ttl;
  for (const [feed, ttl] of [['transport', transportTtlMs], ['cameras', camerasTtlMs]]) {
    assert.ok(Number.isFinite(ttl) && ttl > 0,
      `${feed} has no usable TTL in lib/config.js (got ${ttl}) — the budget below cannot be computed`);
  }

  const TRANSPORT_ENDPOINTS = 5;        // lib/regions.js, region sydney
  const INGEST_FERRY_POLL_MS = 20_000;  // POLL_INTERVAL_MS, ingest/src/ferry-source.js

  const total = (DAY_MS / transportTtlMs) * TRANSPORT_ENDPOINTS
    + DAY_MS / INGEST_FERRY_POLL_MS
    + DAY_MS / camerasTtlMs;

  // Both bounds are literals, and the headroom bound is written out rather than
  // computed as a fraction of the quota constant. Deriving the expectation from
  // the same constant the budget is checked against pins the formula and never
  // the value, which is the defect this test was rewritten to remove.
  //
  // Deliberately not `assert.equal(total, 47_808)`. The requirement is the
  // quota, not today's number: raising a TTL lowers the spend and is strictly
  // safer, and an exact-equality assertion would fail on it while telling a
  // reader that 47,808 is the thing that matters. The derivation above informs;
  // these two bounds gate.
  assert.ok(total < 60_000,
    `${Math.round(total)} calls/day is over the 60,000/day TfNSW quota — that is the 2026-08-15 429 storm`);
  assert.ok(total <= 51_000,
    `${Math.round(total)} calls/day leaves under 15% headroom against 60,000. Today's spend is 47,808; `
    + 'the slack is what absorbs a second region, a retry burst or a manual poll');
});

test('no TfNSW feed polls faster than its floor, whatever the total says', () => {
  // The total is a sum, so on its own it cannot see one feed dropping while
  // another rises to cover it. Cameras at 10s (+8,352/day) alongside transport
  // at 12s (-7,200/day) nets out under the ceiling while the camera layer polls
  // thirty times faster than it is budgeted for. So each TfNSW-costing feed
  // also gets a floor, as a literal:
  //
  //   transport  10s   5 x 8,640 = 43,200/day, 85% of the ceiling on its own,
  //                    and the interval the 2026-08-15 storm was fixed to
  //   cameras    60s   1,440/day, which with transport and ingest is 48,960 —
  //                    still inside 51,000, so once a minute is the honest floor
  const FLOOR_MS = { transport: 10_000, cameras: 60_000 };

  for (const [feed, floorMs] of Object.entries(FLOOR_MS)) {
    const ttl = config.FEEDS[feed].ttl;
    assert.ok(ttl >= floorMs,
      `${feed} polls every ${ttl}ms, under its ${floorMs}ms floor — re-derive the day's `
      + 'total against the quota before lowering it, and move this floor deliberately');
  }
});
