import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The DEFAULT warm set, which is the one figure the "64 cold regions are free"
// argument rests on, and which nothing was pinning.
//
// It needs its own file. test/poller-reaping.test.js sets
// PHILOTAS_WARM_REGIONS explicitly before it imports lib/cache.js — correctly,
// because it is testing the reaping mechanism — and lib/cache.js reads the
// variable once at module scope, so that file can never observe the fallback.
// Measured on this branch: changing the default from 'sydney' to
// 'sydney,tokyo,hormuz,dover' left the whole suite at 536 / 532 / 0 fail.
//
// What the default costs, at the shipped aviation TTL of 20 s
// (AVIATION_TTL_MS, lib/config.js): 86,400 / 20 = 4,320 adsb.fi calls a day per
// warm region. One warm region is 4,320 calls a day. All 83 would be 358,560,
// against a free volunteer feeder network, from a one-word edit or a stray
// value in the deploy environment.

// lib/cache.js reaches sample-lake JSON through the vessel feed, which imports
// it without an import attribute. Same loader shim, and for the same reason, as
// test/poller-reaping.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

let cache;
let config;
let frames;
let previousWarm;
let previousDatabaseUrl;

before(async () => {
  // Unset, so what is measured below is the fallback in lib/cache.js and not
  // whatever this machine happens to export. Restored in `after`.
  previousWarm = process.env.PHILOTAS_WARM_REGIONS;
  delete process.env.PHILOTAS_WARM_REGIONS;

  // lib/cache.js pulls in lib/frames.js, which picks its archive backend from
  // DATABASE_URL at import time. Nothing here calls getFeed() so nothing is
  // ever written, but selecting the file backend is free and makes that
  // guarantee structural rather than a claim about the call graph.
  previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  cache = await import('../lib/cache.js');
  config = await import('../lib/config.js');
  frames = await import('../lib/frames.js');
  assert.equal(frames.archiveKind, 'file', 'this test must never reach a Postgres archive');
});

after(() => {
  if (previousWarm === undefined) delete process.env.PHILOTAS_WARM_REGIONS;
  else process.env.PHILOTAS_WARM_REGIONS = previousWarm;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

test('with nothing configured, exactly one region polls while nobody is looking', () => {
  assert.deepEqual(cache._warmRegions(), ['sydney'],
    'the default warm set is the flagship region and nothing else — every other '
    + 'region polls only while it is being viewed, which is what makes 64 cold '
    + 'regions free rather than 64 times the load on a volunteer feeder network');
});

test('the aviation cadence the warm set is priced at has not moved either', () => {
  // The blast radius is the product of the two, so pinning one without the
  // other pins nothing. 20 s is 4,320 calls a day for one warm region; at 83 it
  // would be 358,560.
  assert.equal(config.FEEDS.aviation.ttl, 20_000);
  const callsPerDayPerRegion = 86_400_000 / config.FEEDS.aviation.ttl;
  assert.equal(callsPerDayPerRegion, 4_320);
  assert.equal(cache._warmRegions().length * callsPerDayPerRegion, 4_320,
    'the shipped adsb.fi spend for regions nobody is looking at');
});
