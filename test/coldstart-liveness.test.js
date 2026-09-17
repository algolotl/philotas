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
// Same shim, and for the same reason, as test/cache-archive-fallback.test.js —
// inline as a data: URL so it needs no file of its own, since any .js under
// test/ would be picked up by `node --test` as a test file.
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-coldstart-liveness-'));

let cache;
let frames;
let payloadVersionFor;

before(async () => {
  delete process.env.DATABASE_URL;
  process.chdir(scratch);
  frames = await import('../lib/frames.js');
  cache = await import('../lib/cache.js');
  ({ payloadVersionFor } = await import('../lib/payload-version.js'));
  // Asserted rather than assumed. Three tests in this repo were writing into
  // the trial's live archive, and the only reason anyone noticed was a frame
  // count that did not add up. If DATABASE_URL survives into this process the
  // whole file is pointed at production, so refuse to run rather than pollute
  // it.
  assert.equal(frames.archiveKind, 'file', 'these tests must run against a scratch file archive');
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const HOUR_MS = 3_600_000;

// A payload that never changes, which is the whole subject of this file. fires,
// seismic and hotspots return exactly this for days at a time when nothing is
// burning or shaking, and lib/frames.js deliberately stores one frame for the
// whole run rather than 2,880 identical ones.
const quietPayload = () => ({ type: 'FeatureCollection', features: [] });

const busyPayload = (n) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [151.2, -33.85] },
    properties: { id: i },
  })),
});

// A one-hour TTL puts staleAfterMsFor() at three hours — max(3 * ttl, 2 *
// ARCHIVE_INTERVAL_MS) — and stops the background poller firing inside the
// test. Every frame below is either seconds old or twenty hours old, so nothing
// sits near the line and no assertion turns on a millisecond.
const regionFor = (feed, id) => ({ id, bbox: null, params: { [feed]: { ttl: HOUR_MS } } });

// A cold start with the first refresh still in flight, which is the state the
// trial is in for the ten seconds this defect is visible. The stub never
// settles, so the background refresh cannot write a frame, advance a stamp or
// overwrite the cache entry underneath an assertion.
async function coldStartWithRefreshInFlight(feed, regionId) {
  const original = cache.FETCHERS[feed];
  cache.FETCHERS[feed] = () => new Promise(() => {});
  try {
    return await cache.getFeed(feed, regionFor(feed, regionId));
  } finally {
    cache.FETCHERS[feed] = original;
  }
}

// A frame on disk with NO freshness stamp beside it, written the way the file
// backend writes one rather than through archive() — because archive() is
// exactly what would leave a stamp.
function writeFrameWithoutStamp(feed, region, t, payload) {
  const dir = path.join(scratch, '.data', 'frames', `${feed}__${region}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${t}.v${payloadVersionFor(feed)}.gz`),
    zlib.gzipSync(Buffer.from(JSON.stringify(payload)))
  );
}

test('a layer whose payload never changes is still live after a restart', async () => {
  // The defect itself. fires reads zero features for days at a time, so the
  // unchanged-frame skip means its newest STORED frame is twenty hours old
  // while the feed has been answering on every poll throughout. Judging that on
  // the frame's age measures how long the world has been boring, and put NOT
  // LIVE on four of twelve working layers on the public trial three seconds
  // after a restart.
  const now = Date.now();
  const frameT = now - 20 * HOUR_MS;

  frames._resetCadenceState();
  assert.equal(await frames.archive('fires', 'quiet-live', quietPayload(), frameT), 'written');
  assert.equal(await frames.archive('fires', 'quiet-live', quietPayload(), now), 'unchanged');

  // The restart. Every in-memory cadence and throttle marker goes; only what
  // was written durably survives, which is one twenty-hour-old frame and the
  // freshness stamp.
  frames._resetCadenceState();

  const served = await coldStartWithRefreshInFlight('fires', 'quiet-live');

  assert.equal(served.payload.features.length, 0, 'the archived frame is what is served');
  assert.equal(served.live, true, 'a feed that answered a moment ago is live, however old its newest frame');
});

test('a layer whose upstream has been failing is not live after a restart', async () => {
  // The direction that must survive fixing the test above. Weakening the
  // staleness test would pass that one and destroy the only guarantee this
  // product actually sells, so this is the load-bearing half: the stamp
  // advances on a successful poll and on nothing else, so an upstream that
  // stopped answering twenty hours ago carries a stamp from twenty hours ago
  // and the layer has to read as history.
  const now = Date.now();
  const lastGoodT = now - 20 * HOUR_MS;

  frames._resetCadenceState();
  assert.equal(await frames.archive('fires', 'dead-upstream', quietPayload(), lastGoodT), 'written');
  // Nothing after that: every poll since threw, so lib/cache.js never reached
  // archive() again and there is nothing to advance the stamp.

  frames._resetCadenceState();

  const served = await coldStartWithRefreshInFlight('fires', 'dead-upstream');

  assert.equal(
    await frames.freshAsOf('fires', 'dead-upstream'),
    lastGoodT,
    'the stamp stopped when the feed did'
  );
  assert.equal(served.live, false, 'twenty hours without a successful poll is not live');
});

test('a poll that fails leaves the freshness stamp alone', async () => {
  // The rule the test above depends on, stated where it can be broken. A stamp
  // that advanced on a failure would make a dead upstream read as live for
  // ever. It holds structurally today — lib/cache.js reaches archive() only on
  // the success path of refreshFeed(), never from its catch — and this is what
  // makes adding an archive() call to that catch go red instead of quietly
  // dismantling the guarantee.
  const regionId = 'failing-poll';
  const original = cache.FETCHERS.fires;
  cache.FETCHERS.fires = async () => { throw new Error('upstream refused'); };

  let served;
  try {
    served = await cache.getFeed('fires', regionFor('fires', regionId));
  } finally {
    cache.FETCHERS.fires = original;
  }

  assert.match(served.error, /upstream refused/, 'the poll really did fail');

  // Drained before asserting. lib/cache.js archives without awaiting — the
  // live picture must not depend on the history — so a stamp written off the
  // failure path would land AFTER getFeed() resolved, and an assertion taken
  // immediately would pass while the stamp was in flight. One stamp write
  // measures 1.2 ms on this backend, so this is ~80x headroom.
  await new Promise((resolve) => { setTimeout(resolve, 100); });

  assert.equal(
    await frames.freshAsOf('fires', regionId),
    null,
    'a failure is not evidence that the feed is answering'
  );
});

test('the freshness stamp advances on the unchanged archive outcome, not only on written', async () => {
  // The mechanism under the first test, pinned on its own so a regression says
  // which half broke. `unchanged` is a successful poll that stores nothing, and
  // before this it left no durable trace at all — which is precisely why a
  // restart could not tell a quiet feed from a dead one.
  const t = Date.now() - 10 * HOUR_MS;
  const staticPayload = busyPayload(3);

  frames._resetCadenceState();
  assert.equal(await frames.archive('berths', 'stamp-advance', staticPayload, t), 'written');
  assert.equal(await frames.freshAsOf('berths', 'stamp-advance'), t);

  assert.equal(await frames.archive('berths', 'stamp-advance', staticPayload, t + 122_000), 'unchanged');
  assert.equal(
    await frames.freshAsOf('berths', 'stamp-advance'),
    t + 122_000,
    'a poll that stores nothing because nothing changed still proves the feed answered'
  );

  // And it really was the dedup path rather than a second write: one frame on
  // disk, not two.
  assert.equal((await frames.coverage('berths', 'stamp-advance')).frames, 1);
});

test('a feed with no freshness stamp falls back to the age of its own frame', async () => {
  // Every (feed, region) is in this state until its first poll after this
  // ships, and any pair whose freshness store is unreadable lands here too. The
  // fallback has to be the behaviour that shipped before the stamp existed, in
  // BOTH directions: an absent stamp is not evidence of life and not evidence
  // of death.
  const now = Date.now();
  writeFrameWithoutStamp('fires', 'nostamp-recent', now - 5_000, busyPayload(3));
  writeFrameWithoutStamp('fires', 'nostamp-old', now - 20 * HOUR_MS, busyPayload(3));

  assert.equal(await frames.freshAsOf('fires', 'nostamp-recent'), null);
  assert.equal(await frames.freshAsOf('fires', 'nostamp-old'), null);

  const recent = await coldStartWithRefreshInFlight('fires', 'nostamp-recent');
  const old = await coldStartWithRefreshInFlight('fires', 'nostamp-old');

  assert.equal(recent.live, true, 'a five-second-old frame is the picture');
  assert.equal(old.live, false, 'a twenty-hour-old frame with nothing vouching for the feed is history');
});

test('a stale stamp never drags a current frame down with it', async () => {
  // The stamp can only ever ADD liveness, never remove it, and that property is
  // what makes this change safe to ship: nothing that read as live before can
  // read as dead after it. The case is real — the stamp is throttled and its
  // write can fail, so a pair can have current frames and a stamp from hours
  // ago — and it is the reason liveness takes the LATER of the two rather than
  // simply believing the stamp.
  const now = Date.now();

  frames._resetCadenceState();
  // The last stamp this pair managed to persist, twenty hours ago.
  assert.equal(await frames.archive('weather', 'stale-stamp', busyPayload(1), now - 20 * HOUR_MS), 'written');
  assert.equal(await frames.freshAsOf('weather', 'stale-stamp'), now - 20 * HOUR_MS);

  // Frames have gone on being written since, which is evidence of a live feed
  // in its own right.
  writeFrameWithoutStamp('weather', 'stale-stamp', now - 5_000, busyPayload(4));
  frames._resetCadenceState();

  const served = await coldStartWithRefreshInFlight('weather', 'stale-stamp');

  assert.equal(served.from_archive_ms, now - 5_000, 'the newest frame is the one being served');
  assert.equal(served.live, true, 'a five-second-old frame is live whatever the stamp says');
});

test('from_archive_ms reports the age of the data, not the freshness stamp', async () => {
  // Freshness of the FEED and age of the DATA are different facts and both have
  // to stay true. The operator is looking at a twenty-hour-old picture and the
  // UI says "recorded 20 hours ago" off this field; repointing it at the stamp
  // would make the banner lie about what is on screen in order to make the
  // header light go green.
  const now = Date.now();
  const frameT = now - 20 * HOUR_MS;

  frames._resetCadenceState();
  await frames.archive('seismic', 'archive-age', quietPayload(), frameT);
  await frames.archive('seismic', 'archive-age', quietPayload(), now);
  frames._resetCadenceState();

  const served = await coldStartWithRefreshInFlight('seismic', 'archive-age');
  const stamped = await frames.freshAsOf('seismic', 'archive-age');

  assert.equal(served.from_archive_ms, frameT, 'the age of the data on screen, unchanged');
  assert.equal(served.at, frameT, 'and the timestamp it is filed under');
  assert.notEqual(served.from_archive_ms, stamped, 'the stamp is a different number and stays one');
  // Both facts true at once, which is the entire point: the data is old AND the
  // feed is answering.
  assert.equal(served.live, true);
});

test('the failed-refresh fallback judges liveness the same way as the cold start', async () => {
  // lib/cache.js makes this age judgement in two places. The second is the
  // catch in refreshFeed(), reached when a poll fails and there is no payload
  // in this process at all — and it can only find an archived frame there if
  // one appeared AFTER this process last looked, which on the trial means
  // another worker wrote it to the shared archive. That is what the stub below
  // stands in for: the frame and the stamp both land while this call is in
  // flight, and then the call fails.
  //
  // Without the same treatment the inversion would be fixed for the restart
  // whose first poll succeeds and left in place for the restart whose first
  // poll happens to fail.
  const now = Date.now();
  const frameT = now - 20 * HOUR_MS;
  const regionId = 'errorpath-quiet';

  frames._resetCadenceState();
  const original = cache.FETCHERS.fires;
  cache.FETCHERS.fires = async () => {
    await frames.archive('fires', regionId, quietPayload(), frameT);
    await frames.archive('fires', regionId, quietPayload(), Date.now());
    throw new Error('upstream refused');
  };

  let served;
  try {
    served = await cache.getFeed('fires', regionFor('fires', regionId));
  } finally {
    cache.FETCHERS.fires = original;
  }

  assert.match(served.error, /upstream refused/, 'the failure is still reported');
  assert.equal(served.from_archive_ms, frameT, 'and the data is still labelled with its own age');
  assert.equal(served.live, true, 'a feed stamped a moment ago is live even on the failure path');
});
