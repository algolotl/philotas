// Shared rate limiter for the corpus enrichment sources (GDELT, NSW Health,
// AMSA). Same shape as lib/tfnsw-limit.js — a serialised in-process queue
// with a minimum gap between requests — but keyed PER SOURCE rather than
// pooled: TfNSW pools because five feeds share one API key and one budget.
// GDELT, NSW Health and AMSA are three unrelated hosts with three unrelated
// budgets, so a GDELT backoff must not also stall an AMSA request that would
// otherwise succeed right now.
//
// The reason this file exists at all is empirical, not precautionary: GDELT
// is already returning 429 under the load the entity-connections background
// pass puts on it (see lib/corpus/sources/gdelt.js). That pass walks ~250
// entities; retrying a 429'd host on a fixed interval just prolongs the
// block, so a 429 here backs off exponentially — capped, and reported via a
// console warning rather than silently retried — instead of hammering at the
// same cadence.
//
// Same caveat as tfnsw-limit.js: this is a plain in-process queue, correct
// for one replica, and would need a shared store (Redis or similar) across
// several.

// GDELT states its limit in the body of its own 429: "Please limit requests to
// one every 5 seconds". 6s honours that with margin rather than probing it.
// This is a floor for every source, not a GDELT special case — a source that
// tells you its limit is the cheapest information you will ever get.
// GDELT states one request per five seconds in its own 429 body. Measured
// 2026-08-15 from the reference deployment, six sequential requests at each spacing:
//
//     6s gap    0 of 6 succeeded   (3 rate-limited, 3 timed out)
//    20s gap    2 of 6 succeeded   (4 rate-limited, 0 timed out)
//
// So the stated limit is not the real one, and the timeouts that looked like
// network flakiness were a symptom of asking too often — at 20s they stopped
// entirely. Honouring the documented figure was still producing a service that
// never answered. This is a floor for every source, not a GDELT special case;
// a source that tells you its limit is the cheapest information you will ever
// get, and measuring whether the limit is true is the second cheapest.
const MINIMUM_GAP_MS = 20_000;
const BASE_BACKOFF_MS = 5_000;      // first 429's penalty
const MAX_BACKOFF_MS = 5 * 60_000;  // ceiling: never make an entity wait more than 5 minutes

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Per-source queue state: { queueTail, lastDispatchMs, backoffUntilMs, backoffMs }.
const sourceState = new Map();

function stateFor(sourceId) {
  let s = sourceState.get(sourceId);
  if (!s) {
    s = { queueTail: Promise.resolve(), lastDispatchMs: 0, backoffUntilMs: 0, backoffMs: 0 };
    sourceState.set(sourceId, s);
  }
  return s;
}

// A source's `task` should throw an Error with `.status === 429` (or a
// message containing "429") on a rate-limit response, so this can tell "the
// source is rate-limiting us — back off" apart from "the source is broken —
// don't compound the problem by treating it like a rate limit". Any other
// error passes straight through with no backoff applied.
function isRateLimit(err) {
  return err?.status === 429 || /\b429\b/.test(String(err?.message || ''));
}

// Run `task` on `sourceId`'s own queue. Preserves both resolution and
// rejection, so callers (lib/corpus/retrieve.js) keep their own error
// handling — this only ever adds delay, never swallows an outcome.
export function corpusRequest(sourceId, task) {
  const s = stateFor(sourceId);
  const scheduled = s.queueTail.then(async () => {
    const untilBackoff = s.backoffUntilMs - Date.now();
    if (untilBackoff > 0) await wait(untilBackoff);

    const sinceLast = Date.now() - s.lastDispatchMs;
    if (sinceLast < MINIMUM_GAP_MS) await wait(MINIMUM_GAP_MS - sinceLast);

    s.lastDispatchMs = Date.now();
    try {
      const result = await task();
      s.backoffMs = 0; // a clean response resets the backoff ladder
      return result;
    } catch (err) {
      if (isRateLimit(err)) {
        s.backoffMs = s.backoffMs ? Math.min(s.backoffMs * 2, MAX_BACKOFF_MS) : BASE_BACKOFF_MS;
        s.backoffUntilMs = Date.now() + s.backoffMs;
        console.warn(`[corpus-limit] ${sourceId} 429 — backing off ${s.backoffMs}ms`);
      }
      throw err;
    }
  });
  // The tail must not reject, or one failure would poison every queued
  // request behind it for this source.
  s.queueTail = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

// Exported for testing only — lets a test observe/reset backoff state
// without waiting on real timers. Nothing outside this module and its test
// should read source state directly.
export function _backoffMsFor(sourceId) {
  return sourceState.get(sourceId)?.backoffMs || 0;
}
