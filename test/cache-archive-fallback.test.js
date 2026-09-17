import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { register } from 'node:module';

// lib/cache.js reaches lib/data/sample-lake/berths.json through the vessel feed,
// which imports it without an import attribute. Next's bundler resolves bare
// JSON imports natively; Node's own ESM loader requires `with { type: 'json' }`.
// Same shim, and for the same reason, as test/cache-dedup.test.js — inline as a
// data: URL so it needs no file of its own, since any .js under test/ would be
// picked up by `node --test` as a test file.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-archive-fallback-'));

let cache;
let payloadVersionFor;

before(async () => {
  delete process.env.DATABASE_URL;
  process.chdir(scratch);
  cache = await import('../lib/cache.js');
  ({ payloadVersionFor } = await import('../lib/payload-version.js'));
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

function writeFrameAtVersion(feed, region, t, payload, payloadVersion) {
  const dir = path.join(scratch, '.data', 'frames', `${feed}__${region}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = payloadVersion === null ? `${t}.gz` : `${t}.v${payloadVersion}.gz`;
  fs.writeFileSync(path.join(dir, name), zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
}

// A region whose upstream always fails, so getFeed() is forced down the archive
// fallback that served the pre-deploy london frame in the first place.
async function feedWithFailingUpstream(feed, regionId) {
  const original = cache.FETCHERS[feed];
  cache.FETCHERS[feed] = async () => { throw new Error('upstream refused'); };
  try {
    const region = { id: regionId, bbox: null, params: { [feed]: { ttl: 3_600_000 } } };
    return await cache.getFeed(feed, region);
  } finally {
    cache.FETCHERS[feed] = original;
  }
}

test('an archive holding only superseded frames behaves exactly like an empty one', async () => {
  // News, because news is the only feed whose shape actually moved and therefore
  // the only one that can hold an archive it cannot read.
  const t = Date.now();

  // One frame explicitly at the previous version, one from before versioning
  // existed — which resolves to that same previous version. Both are on disk,
  // neither is the GKG shape, so neither can be shown.
  writeFrameAtVersion('news', 'only-old', t - 5_000, fc(7), payloadVersionFor('news') - 1);
  writeFrameAtVersion('news', 'only-old', t - 4_000, fc(7), null);

  const withUnreadableArchive = await feedWithFailingUpstream('news', 'only-old');
  const withNoArchive = await feedWithFailingUpstream('news', 'never-archived');

  assert.equal(withUnreadableArchive.payload.features.length, 0, 'no stale shape reaches the map');
  assert.equal(withUnreadableArchive.from_archive_ms, withNoArchive.from_archive_ms);
  assert.equal(withUnreadableArchive.stale, withNoArchive.stale);
  assert.equal(withUnreadableArchive.live, withNoArchive.live);
  // "Not usable" is not "broken": the only error reported is the upstream's own,
  // the same one an empty archive reports.
  assert.equal(withUnreadableArchive.error, withNoArchive.error);
  assert.match(withUnreadableArchive.error, /upstream refused/);
});

test('a current-version archived frame is still served when upstream fails', async () => {
  // The positive control for the test above. Without it, a version guard that
  // rejected every frame — including ones this build wrote — would pass that
  // test perfectly while having silently removed the archive fallback the news
  // layer depends on after a restart.
  const t = Date.now();
  writeFrameAtVersion('news', 'has-current', t - 5_000, fc(7), payloadVersionFor('news'));

  const served = await feedWithFailingUpstream('news', 'has-current');

  assert.equal(served.payload.features.length, 7, 'the archived frame is what the map draws');
  assert.equal(served.from_archive_ms, t - 5_000, 'and it is labelled as history, with its true age');
});

test('a pre-versioning frame still feeds the fallback for a layer that never changed shape', async () => {
  // The 12,139 rows on the trial, at the point where they actually matter. This
  // is the restart-with-a-failing-upstream path the durable archive exists for,
  // and for every feed but news it has to keep working against frames that
  // carry no version marker at all. If this goes red, the fix has become the
  // sledgehammer.
  const t = Date.now();
  assert.equal(payloadVersionFor('weather'), 1, 'weather is still on the pre-versioning shape');
  writeFrameAtVersion('weather', 'legacy', t - 5_000, fc(7), null);

  const served = await feedWithFailingUpstream('weather', 'legacy');

  assert.equal(served.payload.features.length, 7, 'two days of history survive the deploy');
  assert.equal(served.from_archive_ms, t - 5_000);
});
