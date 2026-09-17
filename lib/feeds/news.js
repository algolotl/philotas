// News / GDELT — recent coverage, region-aware.
//
// Served from the bulk GKG window, not from a per-region query.
//
// The DOC API rate-limits per address: measured 2026-08-15, 2 of 6 requests
// succeeded at a 20-second spacing, each taking 12 to 20 seconds. Nineteen
// regions each querying it was 912 requests a day and most of them failed.
// The bulk file measured 396 ms for the bare fetch and 2,217 ms end to end
// for 350 records once inflate and parse are counted (both measured
// 2026-08-15); either figure is one poll for the whole world, and every
// record carries a geocoded coordinate, so articles sit where the story is
// rather than on a placement this file had to invent for each one.
//
// lib/corpus/sources/gdelt.js still queries the DOC API for corpus
// enrichment and shares its own per-provider budget via lib/corpus/limit.js.
// That budget constraint does not bind this file any more now that it reads
// the bulk window instead, but it is still live for that other caller.

import { fetchLatestGkg } from './gdelt-gkg.js';
import { ingest, withinBbox, count } from '../corpus/news-store.js';

// The shape of what fetchNews() returns, stamped onto every archived frame so a
// frame written by an older build is skipped rather than served. See
// lib/payload-version.js for why this is a number a human bumps and not
// anything derived from the payload.
//
// 1 — DOC API, which is also PAYLOAD_VERSION_BASELINE, the shape everything was
//     in before frames carried a version. Sixty articles a query, placed on a
//     spiral around the region centroid because the API returned no
//     coordinates. No `source`, no `window_records`, no `placed_at`.
// 2 — bulk GKG window. Real geocodes per mention, `source: 'gdelt-gkg'`,
//     `window_records`, and a `placed_at` naming the location that put the
//     article where it is.
//
// Bumped with the GKG rewire (08173fd). This is the ONLY feed off the baseline,
// and deliberately so: a bump costs that feed its archived history, and news is
// the only layer whose payload actually changed. The pre-GKG frames are skipped
// because this number moved; every other layer keeps its 48 hours because no
// other number did.
export const NEWS_PAYLOAD_VERSION = 2;

// One refresh per interval across ALL regions. GDELT publishes every 15
// minutes, so asking more often returns the same file.
export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
// While the last refresh failed, retry sooner than the normal cadence so a
// recovered upstream is noticed quickly — but still gated well above the
// per-region poll rate, so an outage degrades to one shared retry every two
// minutes rather than turning into a request-rate storm.
export const RETRY_INTERVAL_MS = 2 * 60 * 1000;

let lastRefreshMs = 0;
let refreshing = null;
// Sticky across calls: null once the last refresh succeeded, otherwise a
// { kind, detail } naming the refresh that most recently failed. A single call
// sees its own outcome; every other call in the same process shares this until
// a refresh actually succeeds. See fetchNews() for why a per-call local used to
// hide this from all but one caller in ~285.
//
// `kind` separates the two failure classes, because they are not the same
// problem and the notice should not have to be read as though they were:
//   'upstream'   — tagged `.unavailable`, which today means GkgUnavailable from
//                  lib/feeds/gdelt-gkg.js: GDELT was unreachable, answered with
//                  a non-200, or sent an archive that did not inflate.
//   'unexpected' — anything else, which means this module's own refresh chain
//                  threw. No upstream input reaches it today; it exists because
//                  "I do not recognise this failure" used to be the branch that
//                  reported perfect health.
let lastRefreshFailure = null;

// Test-only: undoes all of the above so a fresh test does not inherit the
// refresh cadence, or the outage state, left behind by a previous one. Mirrors
// the _reset() convention lib/corpus/news-store.js already establishes.
export function _resetRefreshGate() {
  lastRefreshMs = 0;
  refreshing = null;
  lastRefreshFailure = null;
}

// Terms of a news query, as lowercased substrings. The configs this module
// serves are OR-lists ('earthquake OR election OR ...'), single names, or
// quoted phrases; parens and quotes are stripped so '"Washington DC"' matches
// as the substring 'washington dc'. The filter is OR-only: an AND-composite
// (Sydney's '(Sydney AND (port OR ...))') would collapse into one un-matchable
// literal term, so every configured query must be an OR-list.
function newsQueryTerms(query) {
  if (!query) return [];
  return query
    .split(/\bOR\b/)
    .map((t) => t.replace(/[()"]/g, '').trim().toLowerCase())
    .filter(Boolean);
}

// Terms are regexes, and a term is curated config. Escape the metacharacters a
// curator might add (a '[' or '*' in a topic name) so a malformed term degrades
// to a literal match instead of throwing during RegExp construction and taking
// the whole news layer down.
function escapeRegexTerm(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A record passes the topical filter when any of its searchable text — the
// organisations, title, source domain, url, or any mentioned place — contains
// any of the query's terms. The world query is an OR-list of topics, so
// matching any topic is a pass, parity with the old DOC semantics.
//
// organisations and locations are guarded with || [] because ingest() (in
// lib/corpus/news-store.js) is a public boundary that only requires an id —
// a store-legal record can reach this filter without either field, and an
// unguarded .concat would throw here, taking the layer down with it.
function matchesNewsQuery(r, re) {
  const fields = (r.organisations || []).concat(r.title, r.source, r.url, (r.locations || []).map((l) => l.name));
  return fields.some((v) => re.test(String(v ?? '')));
}

async function refreshWindow() {
  const { records } = await fetchLatestGkg();
  return ingest(records);
}

export async function fetchNews(region, { refresh = refreshWindow, now = Date.now() } = {}) {
  const interval = lastRefreshFailure === null ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS;

  if (now - lastRefreshMs >= interval) {
    // Claim the slot before awaiting anything — the same race fix
    // lib/frames.js uses for its cadence clock — so the gate check and the
    // claim are one indivisible step and two callers arriving together
    // cannot both see it open.
    //
    // One consequence: a caller that arrives while this refresh is still in
    // flight does NOT reach this gate. Its own `now - lastRefreshMs` is
    // already ~0 (the slot above was claimed synchronously, before any await),
    // so it falls through to serve the window it already has — and, when that
    // window is empty, to the join below instead. `refreshing` /
    // `await refreshing` here only matter for the narrow case where the
    // interval elapses again while a refresh is still pending — e.g. one hung
    // past its own timeout — in which case the next caller joins that same
    // in-flight promise instead of starting a second, overlapping download.
    if (!refreshing) {
      // Date.now(), not the caller's `now`. The cadence is a property of the
      // process, so a caller supplying its own clock can open the gate for its
      // own call without also writing that clock into the shared state — a
      // caller passing a stale `now` would otherwise leave the gate open for
      // the next one and turn one refresh per interval into two.
      lastRefreshMs = Date.now();
      refreshing = refresh()
        .then(() => { lastRefreshFailure = null; })
        .catch((err) => {
          // EVERY rejection records the failure, not only the recognised ones.
          // lastRefreshMs was advanced above, synchronously, before the await —
          // so a rejection that left lastRefreshFailure null reported
          // live: true with no notice, held the interval at
          // REFRESH_INTERVAL_MS instead of RETRY_INTERVAL_MS, and never
          // re-attempted. Fifteen minutes of a clean-looking, silently ageing
          // layer. That is d1688c6's defect with the polarity inverted: there
          // one call in ~285 told the truth, here one call in ~285 is the only
          // one that does.
          if (err?.unavailable) {
            lastRefreshFailure = { kind: 'upstream', detail: err.message };
            return;
          }
          lastRefreshFailure = { kind: 'unexpected', detail: err?.message || String(err) };
          // Recorded AND rethrown. An untagged rejection means a defect in our
          // own code rather than a known outage, and lib/cache.js's catch is
          // what turns it into a logged error with its stack plus a last-good
          // fallback. Recording it makes the next fifteen minutes honest;
          // rethrowing keeps the one signal that says a bug exists.
          throw err;
        })
        .finally(() => { refreshing = null; });
    }
    await refreshing;
  }

  // A caller arriving while the first refresh of this process is still in
  // flight fails the gate above — the slot was claimed synchronously, so its
  // own `now - lastRefreshMs` is ~0 — and used to fall straight through with an
  // empty window. It then reported live: true, window_records: 0 and "No
  // geocoded coverage for this region in the last 24 hours": a positive claim
  // about the region that was simply not true, cached by lib/cache.js for its
  // TTL and written into the 48-hour frame archive. Any two regions polled
  // within the 2,217 ms the bulk fetch measured (2026-08-15) hit it, and the
  // trial runs 19 regions.
  //
  // The download is already paid for, so joining it costs the wait and nothing
  // upstream. Only while the window is empty: once it holds records, serving
  // them without waiting is the right answer and is the whole reason the gate
  // falls through.
  if (refreshing && count() === 0) await refreshing;

  // The catchment, not the map view. A city or chokepoint's news box is three
  // times its map half-extent (see NEWS_CATCHMENT_MULTIPLE in lib/regions.js)
  // because GKG files a story against the place it names and that is frequently
  // a neighbouring one. Country and multi-country views take their own map bbox
  // instead: the multiple was measured at metro scale and does not extrapolate
  // to a continent — see NEWS_CATCHMENT_TYPES. Falls back to `bbox` for the
  // three hand-written regions, which carry a tuned box and are not widened,
  // and to null for `world`, which has no spatial filter at all.
  //
  // The 60 is why the width of that box matters. These are the 60 NEWEST
  // records inside it, not the 60 most relevant to it, so every degree the box
  // gains is a degree that can outbid the region's own coverage on recency
  // alone.
  const hits = withinBbox(region?.newsBbox || region?.bbox || null, 60, now);
  const recordCount = count();

  // The curated topical filter (e.g. the world's earthquake/election/conflict
  // OR-list) is applied after the bbox pass. Once per call: one RegExp over the
  // extracted terms, not one regex per record. When region.params.news.query is
  // absent the extracted term list is empty and the filter is a no-op.
  const query = region?.params?.news?.query;
  const terms = newsQueryTerms(query);
  const re = terms.length > 0 ? new RegExp(terms.map(escapeRegexTerm).join('|'), 'i') : null;
  const filtered = re ? hits.filter((r) => matchesNewsQuery(r, re)) : hits;

  const features = filtered.map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: r.coord },
    properties: {
      layer: 'news',
      title: r.title,
      domain: r.source,
      url: r.url,
      placed_at: r.placedAt,
      tone: r.tone,
      organisations: (r.organisations || []).slice(0, 6),
      seendate: new Date(r.dateMs).toISOString(),
    },
  }));

  let notice = null;
  if (lastRefreshFailure?.kind === 'upstream') {
    // GkgUnavailable's own message already names GDELT ("GDELT bulk
    // unavailable: ..."), so this wraps it as "upstream" rather than repeating
    // "GDELT bulk feed unreachable" around a message that already says almost
    // the same thing.
    notice = `Upstream unreachable (${lastRefreshFailure.detail}); showing ${recordCount} records already collected.`;
  } else if (lastRefreshFailure) {
    // Deliberately NOT "upstream unreachable". Nothing has been established
    // about GDELT on this path — the refresh chain in this process threw, which
    // is a defect here and reads as one.
    notice = `News refresh failed unexpectedly (${lastRefreshFailure.detail}); showing ${recordCount} records already collected.`;
  } else if (recordCount === 0) {
    // The window holds nothing at all, so there is nothing to report about this
    // region either way. "No coverage for this region" would be a claim about
    // the world read off a window that has not been populated — the cold-start
    // falsehood the join above exists to prevent, stated honestly for the case
    // where the window really is empty after a refresh that returned nothing.
    notice = 'No news records in the window yet; nothing has been collected for any region.';
  } else if (features.length === 0) {
    // The window IS populated and this bbox genuinely has nothing in it. A
    // different statement from the one above, on purpose.
    notice = 'No geocoded coverage for this region in the last 24 hours.';
  }

  return {
    type: 'FeatureCollection',
    features,
    generated: now,
    source: 'gdelt-gkg',
    // Whether the refresh mechanism itself is working, not whether this
    // region's bbox happens to contain anything right now. A region with a
    // fresh window and genuinely no news in the last 24 hours is live; a
    // stale window served through an outage is not, even though it still has
    // records to show. Pinned in test/news-feed.test.js — test/liveness.test.js
    // covers cameras and hotspots and says nothing about this feed.
    live: lastRefreshFailure === null,
    window_records: recordCount,
    ...(notice ? { notice } : {}),
  };
}
