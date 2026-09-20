import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { register } from 'node:module';

// lib/cache.js reaches lib/data/sample-lake/berths.json through the vessel feed,
// which imports it without an import attribute. Next's bundler resolves bare
// JSON imports natively; Node's own ESM loader requires `with { type: 'json' }`.
// Same shim, and for the same reason, as test/vessels.test.js — supply the
// attribute in a loader hook rather than bend application source to suit the
// test runner. Inline as a data: URL so it needs no file of its own, since any
// .js under test/ would be picked up by `node --test` as a test file.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

// lib/frames.js roots its file backend at process.cwd() and picks its backend
// from DATABASE_URL at import time, so both are fixed before importing.
const cwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-dedup-'));

let frames;

before(async () => {
  delete process.env.DATABASE_URL;
  process.chdir(scratch);
  frames = await import('../lib/frames.js');
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const fc = (n) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [151.2, -33.85] },
    properties: { id: i },
  })),
});

test('concurrent archive calls in one interval write exactly one frame', async () => {
  // Reproduces what the fires layer actually did on 2026-08-14: five frames
  // landed within eighteen milliseconds because every concurrent caller passed
  // a cadence check that none of them had yet updated — the marker was only set
  // after the gzip and the write had finished.
  frames._resetCadenceState();
  const t = Date.now();

  const results = await Promise.all(
    Array.from({ length: 8 }, () => frames.archive('stampede', 'test', fc(3), t))
  );

  const written = results.filter((r) => r === 'written').length;
  assert.equal(written, 1, `exactly one caller should write, ${written} did`);

  const extent = await frames.coverage('stampede', 'test');
  assert.equal(extent.frames, 1, 'one frame on disk, not eight');
});

test('a failed write hands the interval back rather than skipping it', async () => {
  frames._resetCadenceState();
  const t = Date.now();

  // An unsafe key throws inside archive(). The next legitimate call at the same
  // instant must still be able to write: losing this minute because the last
  // attempt failed would blind the archive for a full interval after any
  // transient error.
  await assert.rejects(() => frames.archive('../escape', 'test', fc(1), t));
  assert.equal(await frames.archive('recovers', 'test', fc(1), t), 'written');
});

test('concurrent getFeed calls make one upstream call, not one each', async () => {
  // The cache's own header comment promises "at most one upstream caller". That
  // held once the cache was warm and did not hold on a cold start, which is the
  // exact moment the page asks for every feed at once.
  const { FETCHERS, getFeed } = await import('../lib/cache.js');

  let calls = 0;
  const original = FETCHERS.weather;
  FETCHERS.weather = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 40));
    return { type: 'FeatureCollection', features: [], generated: Date.now() };
  };

  try {
    const region = { id: `dedup-${Date.now()}`, bbox: null, params: { weather: { ttl: 3_600_000 } } };
    const results = await Promise.all(Array.from({ length: 6 }, () => getFeed('weather', region)));

    assert.equal(calls, 1, `six concurrent readers should cost one upstream call, cost ${calls}`);
    // Every caller still gets a real payload, not an empty placeholder.
    for (const r of results) assert.ok(r.payload, 'each caller receives the payload');
  } finally {
    FETCHERS.weather = original;
  }
});
