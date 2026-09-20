import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

// lib/cache.js reaches sample-lake JSON through the vessel feed, which imports
// it without an import attribute. Same loader shim, and for the same reason, as
// test/vessels.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

// A poller used to run for the life of the process, so a visitor clicking
// through the region selector started one per region permanently. Measured on
// 2026-08-15: eleven regions polling at once, the `world` one spending an
// estimated 2,880 of OpenSky's 4,000 daily credits on a view nobody had open.
//
// These tests assert that a region stops polling when nobody is looking, and
// that the configured warm set does not.

// These tests call getFeed(), and getFeed() archives every successful refresh.
// Two separate things decide where those frames land, and BOTH have to be
// pinned before lib/cache.js is imported:
//
//   - process.cwd(), which lib/frames.js's file backend roots itself at;
//   - DATABASE_URL, which lib/frames.js reads at import time to choose the
//     Postgres backend instead — chdir is irrelevant to that choice.
//
// Without both, this file writes stub frames into whatever archive the machine
// running it happens to have. It has: on this box it left 72
// `.data/frames/weather__probe-<timestamp>/` directories, 32 files in
// `weather__not-warm-probe/`, and stub frames inside the real `fires__sydney`
// archive — including one `.v2.gz` written by an intermediate build, which the
// current reader correctly refuses and which therefore sits in a real archive
// permanently unreadable. On the trial host, where DATABASE_URL is set, the
// same stubs go into the live `frames` table that serves the 48-hour replay.
//
// Same isolation as test/frames.test.js and test/cache-archive-fallback.test.js.
const cwd = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-poller-'));

let cache;
let frames;
let previousWarm;
let previousDatabaseUrl;

before(async () => {
  previousWarm = process.env.PHILOTAS_WARM_REGIONS;
  process.env.PHILOTAS_WARM_REGIONS = 'sydney,london';

  previousDatabaseUrl = process.env.DATABASE_URL;
  // Set to a deliberately unusable value first, then deleted. The point is
  // that the delete is load-bearing on a developer box as well as on the
  // trial: without it, a run on a host that has DATABASE_URL set — which is
  // how the suite was actually run during this branch's Task 5 — selects the
  // Postgres backend at import time and puts stub frames into the live table.
  // Nothing dials this string; makePostgresFrameBackend() connects lazily, and
  // the assertion below fires before any query is issued.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect';
  delete process.env.DATABASE_URL;

  process.chdir(scratch);
  cache = await import('../lib/cache.js');
  frames = await import('../lib/frames.js');
  assert.equal(frames.archiveKind, 'file', 'these tests must never reach a Postgres archive');
});

after(() => {
  if (previousWarm === undefined) delete process.env.PHILOTAS_WARM_REGIONS;
  else process.env.PHILOTAS_WARM_REGIONS = previousWarm;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  process.chdir(cwd);
  // The pollers started above are unref'd intervals with 20 ms TTLs and there
  // is no exported way to stop them, so one can still be mid-write when this
  // runs. maxRetries covers the Windows EBUSY/ENOTEMPTY that produces.
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const stubFeed = (counter) => async () => {
  counter.n += 1;
  return { type: 'FeatureCollection', features: [], generated: Date.now() };
};

test('every frame this file archives lands in the scratch directory, never in the real one', async () => {
  // The isolation itself, asserted rather than trusted. getFeed() below
  // archives a stub payload under a real (feed, region) key, so if either half
  // of the setup is lost the stubs go somewhere that matters: without the
  // chdir into a real .data/frames on disk, without the DATABASE_URL delete
  // into a real `frames` table. archive() is awaited here — lib/cache.js fires
  // it and forgets it — so the assertion cannot pass by running early.
  const feed = 'poller-isolation';
  const region = 'probe';
  assert.equal(await frames.archive(feed, region, { type: 'FeatureCollection', features: [] }), 'written');

  const inScratch = path.join(scratch, '.data', 'frames', `${feed}__${region}`);
  const inRepo = path.join(cwd, '.data', 'frames', `${feed}__${region}`);
  assert.ok(fs.existsSync(inScratch), `the frame belongs in ${inScratch}`);
  assert.ok(!fs.existsSync(inRepo), `and must never appear in ${inRepo}`);
});

test('the warm set is read from configuration, not hardcoded', () => {
  const warm = cache._warmRegions();
  assert.deepEqual(warm.sort(), ['london', 'sydney']);
});

test('a region that is requested starts polling', async () => {
  const counter = { n: 0 };
  const original = cache.FETCHERS.weather;
  cache.FETCHERS.weather = stubFeed(counter);
  try {
    const region = { id: `probe-${Date.now()}`, bbox: null, params: { weather: { ttl: 20 } } };
    await cache.getFeed('weather', region);
    assert.ok(
      cache._activePollers().some((p) => p.endsWith(`:${region.id}`)),
      'a poller exists for the requested region'
    );
  } finally {
    cache.FETCHERS.weather = original;
  }
});

// The reaper, actually observed.
//
// What stood here was a test called 'an idle non-warm region stops polling'
// whose body asserted `cold.n >= coldBefore` — that the region was STILL
// polling. The name and the assertion were opposites, and the assertion was a
// counter compared against itself with `>=`, so it held for every possible
// value of IDLE_REAP_MS. It waited 150 ms against a 300,000 ms threshold; it
// could not observe a reap and never could. Measured on this branch before the
// rewrite: mutating IDLE_REAP_MS to Infinity, and to 0, each left the whole
// suite at 683 / 677 pass / 0 fail.
//
// That constant is not decoration. WARM_REGIONS defaults to `sydney` alone, so
// the reaper is the only thing that stops the other 82 regions polling once the
// view is closed, and a reaper that never fires spends an estimated 2,880 of
// OpenSky's 4,000 daily credits on views nobody has open — against an account
// whose terms restrict this project to non-profit research, and against
// adsb.fi, which is volunteer-funded and serves the bounded regions.
//
// Idleness is driven by node:test's mock timers rather than by waiting. The
// clock the reaper reads and the interval the reaper runs on are both advanced
// synchronously, so the tests below cross a five-minute threshold in a
// millisecond and nothing sleeps. Sleeping is what produced the original bug.
//
// The thresholds are hand-written literals, deliberately. Importing
// IDLE_REAP_MS and deriving the expectation from it would pin the comparison
// and leave the value free — the pattern that has already been found nine times
// on this project.
const IDLE_REAP_THRESHOLD_MS = 300_000;      // five minutes, hand-derived
const ONE_MS_PAST_THRESHOLD = 300_001;

// A fixed instant, so the arithmetic below is the same on every machine. The
// mock clock replaces Date.now(), which is both what getFeed() stamps a request
// with and what the reaper measures idleness against.
const CLOCK_ORIGIN = 1_800_000_000_000;

// Let the fire-and-forget refresh started inside a tick settle before the next
// one. refreshOnce() holds an in-flight promise per (feed, region) and joins
// concurrent callers to it, so back-to-back ticks inside one synchronous
// mock-timer advance would collapse into a single upstream call and understate
// the poll count. setImmediate is not mocked here, so this yields for real.
const settle = () => new Promise((r) => setImmediate(r));

// Only setInterval and Date are mocked. The poller runs on setInterval and the
// reaper reads Date.now(); leaving setTimeout real keeps getFeed()'s cold-start
// deadline and the disk reads underneath it behaving normally.
//
// This is what puts the one `ExperimentalWarning: The MockTimers API is an
// experimental feature` line in the suite output. It is Node announcing its own
// API, not a failure and not something this file emits, and it is the price of
// the reaper being observable at all.
const freezeClock = (t) =>
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: CLOCK_ORIGIN });

const isPolling = (feed, regionId) => cache._activePollers().includes(`${feed}:${regionId}`);

test('a non-warm region idle for exactly the threshold is not reaped, and keeps polling', async (t) => {
  // Kills: IDLE_REAP_MS -> 0, and any value below 300,000; kills `>` weakened
  // to `>=`. The comparison is strict, so a region idle for exactly the
  // threshold is still being watched — reaping it would cut the feed out from
  // under someone whose map is open.
  const cold = { n: 0 };
  const original = cache.FETCHERS.weather;
  cache.FETCHERS.weather = stubFeed(cold);
  freezeClock(t);

  try {
    // The poll interval IS the threshold, so the poller's first tick lands on
    // exactly 300,000 ms of idleness — the boundary itself, not near it.
    const region = {
      id: 'reap-at-threshold',
      bbox: null,
      params: { weather: { ttl: IDLE_REAP_THRESHOLD_MS } },
    };
    await cache.getFeed('weather', region);
    await settle();
    const before = cold.n;

    t.mock.timers.tick(IDLE_REAP_THRESHOLD_MS);
    await settle();

    assert.equal(cold.n, before + 1,
      'the poller ticked and went upstream at exactly 300,000 ms idle, which is '
      + 'also the proof that the clock advance reached the reaper at all');
    assert.ok(isPolling('weather', region.id),
      'a region idle for exactly the threshold is still polling — the reaper '
      + 'compares strictly greater than, so 300,000 ms is not yet stale');
  } finally {
    cache.FETCHERS.weather = original;
  }
});

test('a non-warm region one millisecond past the threshold is reaped and stops calling upstream', async (t) => {
  // Kills: IDLE_REAP_MS -> Infinity (the live credit cost), any value above
  // 300,000, and the comparison inverted to `<` or `<=`.
  const cold = { n: 0 };
  const original = cache.FETCHERS.hotspots;
  cache.FETCHERS.hotspots = stubFeed(cold);
  freezeClock(t);

  try {
    const region = {
      id: 'reap-past-threshold',
      bbox: null,
      params: { hotspots: { ttl: ONE_MS_PAST_THRESHOLD } },
    };
    await cache.getFeed('hotspots', region);
    await settle();
    const before = cold.n;
    assert.ok(isPolling('hotspots', region.id), 'precondition: the region is polling');

    t.mock.timers.tick(ONE_MS_PAST_THRESHOLD);
    await settle();

    assert.ok(!isPolling('hotspots', region.id),
      'one millisecond past 300,000 ms of idleness the poller is gone — this is '
      + 'the assertion the old test inverted, and the reason 82 non-warm regions '
      + 'do not keep spending OpenSky credits on views nobody has open');
    assert.equal(cold.n, before,
      'and the reaping tick itself made no upstream call');

    // The reap has to hold, not just happen once. Three more intervals of
    // clock with nobody asking, and the count is still where it was: this is
    // the credit saving itself, measured rather than inferred from the poller
    // set. It also kills dropping the `return` in the reap branch, which would
    // reap and then go upstream anyway on the same tick.
    //
    // What it does NOT kill: dropping clearInterval while keeping
    // pollers.delete(). The reap branch is idempotent, so a leaked timer just
    // re-runs it and makes no call. That mutation is caught by the
    // reaped-then-revisited test below, where the leaked timer does poll.
    t.mock.timers.tick(ONE_MS_PAST_THRESHOLD * 3);
    await settle();
    assert.equal(cold.n, before,
      'a reaped region makes no further upstream call while nobody is looking');
  } finally {
    cache.FETCHERS.hotspots = original;
  }
});

test('a region that is reaped and then looked at again polls once per interval, not twice', async (t) => {
  // Kills: dropping clearInterval from the reap branch. pollers.delete() alone
  // makes _activePollers() report the region gone while its timer keeps
  // running, so the next visit starts a SECOND interval and the region is
  // polled at twice the configured rate for the rest of the process — a
  // doubled quota spend that every poller-set assertion reports as fixed.
  const cold = { n: 0 };
  const original = cache.FETCHERS.space;
  cache.FETCHERS.space = stubFeed(cold);
  freezeClock(t);

  try {
    const id = 'reaped-then-revisited';
    const slow = { id, bbox: null, params: { space: { ttl: ONE_MS_PAST_THRESHOLD } } };

    // t = origin. The first poller's ticks fall at 300,001 and 600,002.
    await cache.getFeed('space', slow);
    await settle();
    t.mock.timers.tick(ONE_MS_PAST_THRESHOLD);
    await settle();
    assert.ok(!isPolling('space', id), 'precondition: idle past the threshold, so reaped');

    // t = 300,001. Someone opens the view again; a second poller starts, on a
    // cadence chosen so its own ticks never coincide with 600,002.
    const brisk = { id, bbox: null, params: { space: { ttl: 50_000 } } };
    await cache.getFeed('space', brisk);
    await settle();
    t.mock.timers.tick(300_000);   // t = 600,001, the brisk poller's sixth tick
    await settle();

    // Requested again right now, so idleness is 1 ms and nothing is reapable.
    await cache.getFeed('space', brisk);
    const before = cold.n;

    // A single millisecond. t = 600,002 is due for the pre-reap timer and for
    // nothing else, so any upstream call inside this tick came from a timer
    // that should have been cleared five minutes of clock ago.
    t.mock.timers.tick(1);
    await settle();

    assert.equal(cold.n, before,
      'no call at 600,002 ms: the interval from before the reap was cleared, not '
      + 'merely dropped from the poller set, so revisiting a reaped region does '
      + 'not leave it polling twice per interval forever');
  } finally {
    cache.FETCHERS.space = original;
  }
});

test('a warm region is never reaped, no matter how long nobody looks at it', async (t) => {
  // Kills: dropping the `!WARM_REGIONS.has(regionId)` guard, which would put
  // the flagship region on the same idle timer as everything else and take the
  // always-on picture down whenever the trial had no visitors for five minutes.
  const warm = { n: 0 };
  const original = cache.FETCHERS.fires;
  cache.FETCHERS.fires = stubFeed(warm);
  freezeClock(t);

  try {
    const SIX_HOURS_MS = 6 * 3_600_000;
    // `sydney` is in this file's configured warm set (see `before`).
    const region = { id: 'sydney', bbox: null, params: { fires: { ttl: SIX_HOURS_MS } } };
    assert.ok(cache._warmRegions().includes(region.id), 'precondition: sydney is warm here');

    await cache.getFeed('fires', region);
    await settle();
    const before = warm.n;

    // Twenty-four hours without a single request — 288 times the idle threshold.
    for (let i = 0; i < 4; i += 1) {
      t.mock.timers.tick(SIX_HOURS_MS);
      await settle();
    }

    assert.equal(warm.n, before + 4,
      'the warm region polled on every interval across a full day of being '
      + 'ignored; warm means it polls whether or not anyone is looking');
    assert.ok(isPolling('fires', region.id),
      'and its poller is still registered after 24 hours idle');
  } finally {
    cache.FETCHERS.fires = original;
  }
});

test('a non-warm region that keeps being requested is never reaped', async (t) => {
  // Kills: stamping lastRequestedAt somewhere that a request does not reach, or
  // dropping the stamp from getFeed(). The grace window has to be measured from
  // the LAST request, not from the first — otherwise an open map goes dark five
  // minutes after it was opened, which is a worse failure than the one being
  // fixed here.
  const cold = { n: 0 };
  const original = cache.FETCHERS.seismic;
  cache.FETCHERS.seismic = stubFeed(cold);
  freezeClock(t);

  try {
    const region = {
      id: 'watched-probe',
      bbox: null,
      params: { seismic: { ttl: IDLE_REAP_THRESHOLD_MS } },
    };
    await cache.getFeed('seismic', region);
    await settle();

    // Four full threshold intervals, each one re-requested just beforehand the
    // way an open map does. Cumulative idle-since-first-request reaches 20
    // minutes; idle-since-last-request never exceeds the threshold.
    for (let i = 0; i < 4; i += 1) {
      await cache.getFeed('seismic', region);
      t.mock.timers.tick(IDLE_REAP_THRESHOLD_MS);
      await settle();
      assert.ok(isPolling('seismic', region.id),
        `still polling after ${(i + 1) * 5} minutes of being watched`);
    }
  } finally {
    cache.FETCHERS.seismic = original;
  }
});

test('the default warm set is sydney alone', async () => {
  // Documents the production default: one region budgeted, everything else
  // pay-as-viewed. Asserted on the parsing rule rather than by re-importing.
  const parse = (v) => new Set((v || 'sydney').split(',').map((s) => s.trim()).filter(Boolean));
  assert.deepEqual([...parse(undefined)], ['sydney']);
  assert.deepEqual([...parse('sydney,london,auckland')].sort(), ['auckland', 'london', 'sydney']);
  assert.deepEqual([...parse('  sydney , , london ')].sort(), ['london', 'sydney']);
});
