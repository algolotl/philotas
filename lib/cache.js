// Feed cache + background poller + snapshot recorder.
//
// The key idea for rate-limit relief: clients NEVER fetch upstream directly.
// The first time a (feed, region) is requested we start a background poller that
// refreshes it at the feed's TTL; everything else reads the warm cache. One
// polite upstream request per interval feeds any number of clients and refreshes
// — so we stop hitting the limit instead of trying to dodge it. Every successful
// refresh is also recorded to the snapshot store for time-replay.

import { FEEDS } from './config.js';
import { record, latest } from './store.js';
import { archive, newestFrame, freshAsOf, ARCHIVE_INTERVAL_MS } from './frames.js';
import { fetchAviation } from './feeds/aviation.js';
import { fetchSatellites } from './feeds/satellites.js';
import { fetchVessels } from './feeds/vessels.js';
import { fetchTransport } from './feeds/transport.js';
import { fetchCameras } from './feeds/cameras.js';
import { fetchFires } from './feeds/fires.js';
import { fetchHotspots } from './feeds/hotspots.js';
import { fetchSeismic } from './feeds/seismic.js';
import { fetchWeather } from './feeds/weather.js';
import { fetchNews } from './feeds/news.js';
import { fetchSpace } from './feeds/space.js';
import { CONNECTORS } from './connectors/registry.js';

export const FETCHERS = {
  aviation: fetchAviation,
  satellites: fetchSatellites,
  vessels: fetchVessels,
  transport: fetchTransport,
  cameras: fetchCameras,
  fires: fetchFires,
  hotspots: fetchHotspots,
  seismic: fetchSeismic,
  weather: fetchWeather,
  news: fetchNews,
  space: fetchSpace,
  // Registered connectors pull through the same cache + poller + snapshot path.
  ...Object.fromEntries(CONNECTORS.map((c) => [c.id, c.pull])),
};

const EMPTY = { type: 'FeatureCollection', features: [] };

// How long a first-ever request will wait on an upstream before answering
// empty and leaving the refresh to finish in the background. Long enough that
// a healthy source lands inside it — the Sydney transport feed, five upstream
// calls merged, measured 1.2s cold — and short enough that GDELT's sixteen
// seconds never becomes a blank map.
const COLD_START_BUDGET_MS = 2_500;

// How old an archived payload has to be before it stops counting as the current
// picture, scaled to the feed's own refresh rate: three missed refreshes, and
// never less than two recording intervals. Weather at a 2-minute TTL tolerates
// six minutes; vessels at five seconds is bounded by the two-interval floor.
//
// A single number for every layer does not work here. Frames are written once a
// minute, so immediately after a restart every feed answers from a frame that
// is seconds old with a refresh already in flight — and flagging all of those
// produced eleven NOT LIVE banners at once, on the public trial, over data that
// was current.
function staleAfterMsFor(key, region) {
  const ttl = region?.params?.[key]?.ttl || FEEDS[key]?.ttl || 30_000;
  return Math.max(3 * ttl, 2 * ARCHIVE_INTERVAL_MS);
}

const cache = new Map();   // `${feed}:${regionId}` -> { at, payload, error, stale }
const pollers = new Set(); // active `${feed}:${regionId}` intervals
const inFlight = new Map(); // `${feed}:${regionId}` -> Promise, one refresh at a time

// Always hit upstream, update the cache, and record a snapshot on success.
async function refreshFeed(key, region) {
  const regionId = region?.id || 'default';
  const cacheKey = `${key}:${regionId}`;
  try {
    const payload = await FETCHERS[key](region);
    cache.set(cacheKey, { at: Date.now(), payload, error: null, stale: false });
    record(key, regionId, payload);
    // The durable archive decides for itself whether this frame is due and
    // whether it says anything new, so this is a call per poll rather than a
    // write per poll. Failing to archive must never fail a refresh: the live
    // picture does not depend on the history.
    archive(key, regionId, payload).catch(() => {});
    return cache.get(cacheKey);
  } catch (err) {
    // Keep serving the last good payload, just flagged stale. Three places to
    // look, newest first: this process's cache, its in-memory frames, and then
    // the durable archive.
    //
    // That last one is why the news layer used to come back empty. GDELT rate-
    // limits us and its handshake straddles the client timeout, so a restart
    // reliably landed in a state with no cached payload and no in-memory frame,
    // and the layer rendered nothing at all rather than the articles it had
    // been showing a minute earlier. The archive survives the restart.
    const hit = cache.get(cacheKey);
    let payload = hit?.payload || latest(key, regionId)?.fc || null;
    let archivedAt = null;

    if (!payload) {
      const archived = await newestFrame(key, regionId).catch(() => null);
      if (archived) { payload = archived.fc; archivedAt = archived.t; }
    }

    // Same rule as the cold-start branch below, and it is here for the same
    // reason: the frame this path just found may be old because the LAYER is
    // static, not because the feed is dead. Judging it on the frame's age would
    // fix the inversion for the restart whose first poll succeeds and leave it
    // in place for the restart whose first poll happens to fail.
    //
    // The stamp cannot make a dead upstream look alive here. This poll failed,
    // so it never reached archive() and never advanced the stamp; an upstream
    // that has been failing carries a stamp as old as its last success.
    let lastKnownGoodMs = archivedAt;
    if (archivedAt != null) {
      const stampedFreshAsOf = await freshAsOf(key, regionId);
      if (stampedFreshAsOf != null) lastKnownGoodMs = Math.max(stampedFreshAsOf, archivedAt);
    }

    const entry = {
      at: hit?.at || archivedAt || Date.now(),
      payload: payload || EMPTY,
      error: String(err.message || err),
      stale: true,
      // Set only when the payload came off disk rather than out of this
      // process, so the UI can say how old what it is showing actually is
      // instead of implying it is current. The freshness stamp does not touch
      // this: it says the feed is answering, not that the picture is newer.
      from_archive_ms: archivedAt,
      // Recent enough to still be the picture, or old enough to be history. An
      // upstream that has failed once and was last known good forty seconds ago
      // has not stopped being live.
      live: archivedAt == null || Date.now() - lastKnownGoodMs <= staleAfterMsFor(key, region),
    };
    cache.set(cacheKey, entry);
    return entry;
  }
}

// Start one background poller per (feed, region) — at most one upstream caller.
//
// A region may override the interval via `region.params[feed].ttl`. That exists
// because the poller is per-(feed, region): a source with a daily quota is spent
// once per region in play, not once overall. The world view's aviation feed is
// the case in point — it costs 4 OpenSky credits per call against a 4,000/day
// account, so it polls far more slowly than a bounded region on adsb.fi.
// Regions that poll whether or not anyone is looking. Everything else polls
// only while it is being viewed and is reaped when it goes idle.
//
// Without this a poller ran for the life of the process, so a visitor clicking
// through the region selector started one per region permanently. Measured
// 2026-08-15: eleven regions polling at once after an investigation browsed
// them, of which the `world` region alone spent an estimated 2,880 of OpenSky's
// 4,000 daily credits on a view nobody had open. On a public trial that is a
// quota bomb operated by strangers.
//
// Configured rather than inferred, so the daily spend is knowable in advance.
const WARM_REGIONS = new Set(
  (process.env.PARALLAX_WARM_REGIONS || 'sydney')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

// How long after the last request a non-warm region keeps polling. Long enough
// that a visitor reading one region's map does not watch it go stale mid-look,
// short enough that an idle region costs a bounded amount of quota.
const IDLE_REAP_MS = 5 * 60_000;

const lastRequestedAt = new Map(); // regionId -> ms

export function _warmRegions() { return [...WARM_REGIONS]; }
export function _activePollers() { return [...pollers]; }

// Drop every cached payload for one region. Called when its poller is reaped:
// reaping the timer alone left one payload per (feed, region) in memory for the
// life of the process, and a visitor clicking through the region selector is
// exactly how those accumulate — the poller stops, the payload it last fetched
// stays. Dropping it costs one re-fetch if the region is opened again, which is
// the whole point of having reaped it.
function dropRegion(regionId) {
  const suffix = `:${regionId}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

function ensurePoller(key, region) {
  const regionId = region?.id || 'default';
  const id = `${key}:${regionId}`;
  if (pollers.has(id)) return;
  pollers.add(id);

  const ttl = region?.params?.[key]?.ttl || FEEDS[key]?.ttl || 30_000;
  // unref so the poller never becomes the reason this process stays alive. The
  // HTTP listener is what should hold the server open; a background refresh
  // timer holding it open instead means anything that imports this module —
  // a test, a script, a one-off migration — hangs forever on exit.
  const timer = setInterval(() => {
    if (!WARM_REGIONS.has(regionId)) {
      const idleFor = Date.now() - (lastRequestedAt.get(regionId) || 0);
      if (idleFor > IDLE_REAP_MS) {
        clearInterval(timer);
        pollers.delete(id);
        dropRegion(regionId);
        return;
      }
    }
    refreshOnce(key, region).catch(() => {});
  }, ttl);
  timer.unref();
}

// One refresh per (feed, region) at a time. Concurrent callers join the request
// already running instead of starting another.
//
// The header comment above promises "at most one upstream caller", and until
// now that was only true once the cache was warm. On a cold start the page asks
// /api/status for every feed while the map asks /api/feeds/<id> for each active
// layer, and every one of those found an empty cache and went upstream. The
// archive made it visible — the fires layer wrote five frames inside eighteen
// milliseconds — but the frames were a symptom. The real cost was five
// simultaneous upstream calls, and Transport for NSW enforces five requests per
// second across every API sharing the key, so the burst that first populates
// the map is exactly the moment the quota is tightest.
function refreshOnce(key, region) {
  const cacheKey = `${key}:${region?.id || 'default'}`;
  const running = inFlight.get(cacheKey);
  if (running) return running;

  const promise = refreshFeed(key, region).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, promise);
  return promise;
}

export async function getFeed(key, region) {
  const regionId = region?.id || 'default';
  // Stamped before the poller is started, so a region is never reaped in the
  // same tick it was asked for.
  lastRequestedAt.set(regionId, Date.now());
  ensurePoller(key, region);
  const cacheKey = `${key}:${regionId}`;
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit, cached: true };

  // Cold start. Serve the newest archived frame if there is one, and refresh
  // behind the response rather than in front of it.
  //
  // Holding the request open for an upstream call is what made a restart feel
  // broken. GDELT's TLS handshake alone runs to ten seconds from Australia
  // (measured 10.43s, 10.68s, 9.99s on 2026-08-14), so the first person to open
  // the map after a deploy waited out that timeout and was then shown an empty
  // news layer anyway. Disk is microseconds and the frame is at most a minute
  // old, so answer from disk and let the poller catch up.
  //
  // Marked stale with its true age rather than presented as current: the whole
  // point of the archive is that it is honest about being history.
  //
  // This is the request that served a pre-GKG london frame on 2026-08-16 —
  // sixty DOC-API articles on the city centroid, drawn as though current.
  // newestFrame() now refuses a frame whose payload version is not the one this
  // build writes, and it signals that refusal the only way this path can act
  // on: by returning null, exactly as it does for an archive with nothing in
  // it. So "the archive holds only frames I cannot read" falls through to the
  // live refresh below rather than becoming a state of its own, and no error is
  // reported for a condition that is not one. test/cache-archive-fallback.test.js
  // pins both halves of that — the unreadable archive AND the readable one that
  // must still be served, since a guard that refused everything would look
  // identical here.
  const archived = await newestFrame(key, regionId).catch(() => null);
  if (archived) {
    // Archive-served is not automatically not-live.
    //
    // Frames are written once a minute, so straight after a restart every layer
    // is answering from a frame that is seconds old and a refresh is already in
    // flight. Calling all twelve of those NOT LIVE was measured — eleven
    // banners at once, on the public trial, for data that was current. A
    // fortysecond-old transport frame is the picture; a three-hour-old one is
    // history. The line between them belongs at the feed's own cadence, so this
    // scales with the TTL rather than picking one number for every layer.
    //
    // What the line is measured FROM is the other half, and it was wrong. It
    // used the frame's own timestamp, which is when the frame was WRITTEN — and
    // lib/frames.js deliberately writes no frame when the payload hashes the
    // same as the last one. For fires, seismic and hotspots, which read zero
    // features for days at a time, the newest stored frame is old precisely
    // BECAUSE the feed is working and saying the same thing, so the quietest
    // layers were the ones flagged dead. Sampled on the trial 2026-08-15, three
    // seconds after a restart: four of twelve layers reporting NOT LIVE, all
    // four answering normally.
    //
    // So liveness is measured from when the feed was last known GOOD, which
    // lib/frames.js stamps on every successful poll including the deduplicated
    // ones. Math.max, not a replacement: the frame's own timestamp is still
    // evidence the feed was answering at that moment, and a stamp throttled to
    // one write a minute can legitimately trail a frame written just after it.
    //
    // A pair with no stamp — nothing has polled it since this shipped, or the
    // freshness store cannot be read — is judged on the frame's own age exactly
    // as before. Never assumed live, never assumed dead.
    const stampedFreshAsOf = await freshAsOf(key, regionId);
    const lastKnownGoodMs = stampedFreshAsOf == null
      ? archived.t
      : Math.max(stampedFreshAsOf, archived.t);

    const entry = {
      at: archived.t,
      payload: archived.fc,
      error: null,
      stale: true,
      // The frame's own timestamp, and it stays that way. This is the age of
      // the DATA on screen — the UI renders "recorded N minutes ago" from it —
      // which is a different fact from whether the feed is answering. Pointing
      // it at the stamp would make the banner lie about the picture in order to
      // turn the header light green.
      from_archive_ms: archived.t,
      live: Date.now() - lastKnownGoodMs <= staleAfterMsFor(key, region),
    };
    cache.set(cacheKey, entry);
    refreshOnce(key, region).catch(() => {});
    return { ...entry, cached: true };
  }

  // Nothing recorded either — this feed has genuinely never succeeded here.
  // Wait for it, but not indefinitely: the refresh keeps running either way, so
  // a caller that gives up early costs nothing but its own first paint.
  //
  // The bound matters because the slowest sources are the ones most likely to
  // have no archived frame — that is why they have none. GDELT takes sixteen
  // seconds to answer and a person opening the map should not hold a blank
  // screen for it while eleven other layers sit ready to draw.
  return withDeadline(refreshOnce(key, region), COLD_START_BUDGET_MS, () => ({
    at: Date.now(),
    payload: EMPTY,
    error: null,
    stale: true,
    pending: true,
  }));
}

// Resolve with `fallback()` if `promise` has not settled in time. The promise
// is NOT cancelled — it is still populating the cache for the next caller.
function withDeadline(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback()); }
    );
  });
}
