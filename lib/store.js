// In-memory rolling snapshot store, keyed by `${feed}:${regionId}`.
//
// Window: 2 hours, one frame per 30 seconds per feed. That is what fits in
// process memory; a longer replay needs the frames on disk or in Postgres,
// which is a different piece of work.
//
// Every successful upstream poll is recorded here as a timestamped frame. This
// does two jobs at once:
//   1. Rate-limit relief — clients read the latest frame from memory; the
//      upstream is only ever hit by the background poller, at a safe interval.
//   2. Time dimension — the recent frames are a short history we can replay
//      (scrub aircraft / quakes / news backwards over time).
//
// In-memory for now (resets on restart); production would flush to disk/DB.

// Frames are recorded on a UNIFORM CADENCE, not once per poll, and retained by
// elapsed time rather than by count.
//
// Recording every poll under a flat 60-frame cap sounds reasonable and is not:
// the feeds poll at rates that differ by two orders of magnitude, so 60 frames
// bought five minutes of one layer and five hours of another. Measured on this
// deployment, 2026-08-14, 60 frames each:
//
//     cameras 4.92h · weather 1.97h · fires 0.98h · aviation 0.33h · vessels 0.08h
//
// Replaying the union of those axes put the scrub bar across ~5 hours in which
// only the slow, static layers held any data. Aircraft covered the last 7% of
// the travel and vessels the last 2%, so they appeared from nothing near the
// end and read as a glitch rather than as motion.
//
// One frame per interval per feed makes every layer span the same wall clock,
// which is the property replay actually depends on.
const FRAME_INTERVAL_MS = 30_000;
const HISTORY_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_FRAMES = Math.ceil(HISTORY_WINDOW_MS / FRAME_INTERVAL_MS);

export const REPLAY_STEP_MS = FRAME_INTERVAL_MS;

const store = new Map(); // key -> [{ t, fc }]

function k(feed, regionId) { return `${feed}:${regionId || 'default'}`; }

// The per-key trim in record() only runs when that key records AGAIN. A region
// nobody is looking at never does, so it kept its last two hours of frames for
// the life of the process — and every region a visitor clicks through adds
// another one. Measured on the trial: 83 regions x 12 feeds of idle frames is
// what walked the heap up to its 4 GB limit and killed the process. Browsing is
// what creates these keys, so idle accumulation is the normal case, not an edge.
//
// Swept opportunistically rather than on a timer, matching lib/cache.js: a
// process with no traffic should do no work.
let recordsSinceSweep = 0;
const SWEEP_EVERY = 100;

// Exported for testing. Drops every key whose newest frame has aged out.
export function sweepStaleKeys(now = Date.now()) {
  const cutoff = now - HISTORY_WINDOW_MS;
  let removed = 0;
  for (const [key, arr] of store) {
    if (!arr.length || arr[arr.length - 1].t < cutoff) { store.delete(key); removed += 1; }
  }
  return removed;
}

export function record(feed, regionId, fc) {
  const key = k(feed, regionId);
  let arr = store.get(key);
  if (!arr) { arr = []; store.set(key, arr); }

  const now = Date.now();
  const last = arr[arr.length - 1];

  // A feed polling faster than the cadence still refreshes the newest frame in
  // place — it just does not earn a new one. Overwriting rather than dropping
  // keeps `latest()` current for the cache fallback without spending window on
  // a layer that happens to poll quickly.
  if (last && now - last.t < FRAME_INTERVAL_MS) {
    arr[arr.length - 1] = { t: last.t, fc };
    return;
  }

  arr.push({ t: now, fc });

  const cutoff = now - HISTORY_WINDOW_MS;
  while (arr.length && (arr[0].t < cutoff || arr.length > MAX_FRAMES)) arr.shift();

  if (++recordsSinceSweep >= SWEEP_EVERY) { recordsSinceSweep = 0; sweepStaleKeys(now); }
}

export function latest(feed, regionId) {
  const arr = store.get(k(feed, regionId));
  return arr && arr.length ? arr[arr.length - 1] : null;
}

// Last n frames, oldest-first, as {t, count, fc} entries.
export function history(feed, regionId, n = MAX_FRAMES) {
  const arr = store.get(k(feed, regionId)) || [];
  return arr.slice(-n).map((f) => ({ t: f.t, count: f.fc.features?.length ?? 0, fc: f.fc }));
}
