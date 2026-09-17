// test/news-feed.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ingest, _reset } from '../lib/corpus/news-store.js';
import { fetchNews, _resetRefreshGate, REFRESH_INTERVAL_MS, RETRY_INTERVAL_MS } from '../lib/feeds/news.js';

// Matches lib/regions.js's real sydney.bbox, not an approximation of it — a
// fixture that drifts from production config is one more thing that can
// quietly stop representing it.
const SYDNEY = { id: 'sydney', bbox: { west: 150.4, south: -34.3, east: 151.7, north: -33.4 } };

const rec = (over = {}) => ({
  id: over.id ?? 'n1',
  dateMs: over.dateMs ?? Date.now(),
  source: over.source ?? 'smh.com.au',
  url: over.url ?? 'https://smh.com.au/story',
  // Distinct from `source`: the properties.domain assertion below reads
  // r.source, and a title equal to the source could pass even if it were
  // wired to r.title instead.
  title: over.title ?? 'Ferry services suspended after harbour incident',
  locations: over.locations ?? [{ name: 'Sydney, New South Wales, Australia', lat: -33.8833, lon: 151.217 }],
  organisations: over.organisations ?? ['port authority'],
  tone: over.tone ?? -2.5,
});

// fetchNews gates refresh() behind a module-level interval shared across
// every call in the process (REFRESH_INTERVAL_MS / RETRY_INTERVAL_MS in
// lib/feeds/news.js), so a test needs the gate itself reset, not just the
// store, or an earlier test's refresh leaves the next one's gate shut and its
// injected `refresh` never runs. _resetRefreshGate() is the same convention
// news-store.js's own _reset() already establishes.
beforeEach(() => { _reset(); _resetRefreshGate(); });

test('articles are placed at their mentioned coordinates', async () => {
  ingest([rec()]);
  const fc = await fetchNews(SYDNEY, { refresh: async () => ({ added: 0 }) });
  assert.equal(fc.features.length, 1);
  assert.deepEqual(fc.features[0].geometry.coordinates, [151.217, -33.8833]);
  assert.equal(fc.features[0].properties.layer, 'news');
  assert.equal(fc.features[0].properties.placed_at, 'Sydney, New South Wales, Australia');
  assert.equal(fc.features[0].properties.domain, 'smh.com.au');
  assert.equal(fc.features[0].properties.title, 'Ferry services suspended after harbour incident');
  assert.equal(fc.features[0].properties.tone, -2.5);
  assert.equal(fc.features[0].properties.url, 'https://smh.com.au/story');
  assert.equal(fc.source, 'gdelt-gkg');
  assert.equal(fc.window_records, 1);
});

test('organisations are capped at 6 per article', async () => {
  ingest([rec({ organisations: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] })]);
  const fc = await fetchNews(SYDNEY, { refresh: async () => ({ added: 0 }) });
  assert.deepEqual(fc.features[0].properties.organisations, ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('an empty store says so rather than erroring, and a working refresh is still live', async () => {
  const fc = await fetchNews(SYDNEY, { refresh: async () => ({ added: 0 }) });
  assert.equal(fc.features.length, 0);
  // The whole window is empty, so the notice must say that and NOT make a
  // claim about this region. "No geocoded coverage for this region" would be a
  // statement about Sydney read off a window holding nothing at all — see the
  // paired test below, where the window IS populated and the region really is
  // the empty thing.
  assert.match(fc.notice, /no news records in the window/i);
  assert.doesNotMatch(fc.notice, /for this region/i);
  // live means "the refresh mechanism is working", not "this bbox has
  // articles right now" — commit 6aba75c fixed exactly this conflation for
  // another layer. A region with a fresh window and genuinely nothing in it
  // for 24 hours is still live.
  assert.equal(fc.live, true, 'a working refresh with nothing in this bbox is still a live layer');
});

test('an unreachable upstream serves whatever the window already holds, and is not live', async () => {
  ingest([rec()]);
  let called = false;
  const fc = await fetchNews(SYDNEY, {
    refresh: async () => { called = true; const e = new Error('down'); e.unavailable = true; throw e; },
  });
  assert.ok(called, 'the outage path is only proven if refresh() actually ran');
  assert.equal(fc.features.length, 1, 'the accumulated window survives an upstream outage');
  assert.match(fc.notice, /unreachable/i);
  assert.equal(fc.live, false, 'a failed refresh is not live even while it serves stale records');
});

test('the outage notice persists on a second call inside the same interval, not just the one that discovered it', async () => {
  // Regression for the bug where `unreachable` was a per-invocation local:
  // the refresh gate is module-level, so once one call opened it and hit the
  // failure, every other call in the interval found the gate already shut,
  // built its own fresh (null) local, and reported no outage at all — a
  // GDELT outage read as a clean, live news layer for up to 15 minutes.
  ingest([rec()]);
  let calls = 0;
  const failing = async () => { calls += 1; const e = new Error('down'); e.unavailable = true; throw e; };
  const now = Date.now();

  const first = await fetchNews(SYDNEY, { refresh: failing, now });
  assert.match(first.notice, /unreachable/i);
  assert.equal(first.live, false);

  const second = await fetchNews(SYDNEY, { refresh: failing, now: now + 1_000 });
  assert.equal(calls, 1, 'a call inside the interval must not re-trigger refresh');
  assert.match(second.notice, /unreachable/i, 'the outage must still be reported once the gate has closed again');
  assert.equal(second.live, false);
});

test('the outage clears once a refresh succeeds again', async () => {
  ingest([rec()]);
  const now = Date.now();
  const failing = async () => { const e = new Error('down'); e.unavailable = true; throw e; };

  const first = await fetchNews(SYDNEY, { refresh: failing, now });
  assert.equal(first.live, false);

  // Past the shorter retry interval used while degraded, with a refresh that
  // now succeeds.
  const recovered = await fetchNews(SYDNEY, {
    refresh: async () => ({ added: 0 }),
    now: now + RETRY_INTERVAL_MS + 1_000,
  });
  assert.equal(recovered.live, true, 'a successful refresh clears the sticky outage state');
  assert.equal(recovered.notice, undefined, 'no outage notice once the feed is reachable again');
});

test('a region outside the coverage gets an empty collection, not another region\'s news', async () => {
  ingest([rec({ locations: [{ name: 'London', lat: 51.5074, lon: -0.1276 }] })]);
  const fc = await fetchNews(SYDNEY, { refresh: async () => ({ added: 0 }) });
  assert.equal(fc.features.length, 0);
  // Paired with 'an empty store says so...' above. Here the window IS
  // populated — one London record — so "no coverage for this region" is a true
  // statement about Sydney, and it must read differently from the empty-window
  // case. Collapse the two notices into one and one of these two tests fails.
  assert.match(fc.notice, /no geocoded coverage for this region/i);
  assert.equal(fc.window_records, 1, 'the window is loaded; it is the region that is empty');
});

test('a refresh failure this module does not recognise is still recorded, not reported as health', async () => {
  // The inverted twin of the sticky-outage regression above. A rejection
  // WITHOUT `.unavailable` used to rethrow before touching lastRefreshFailure,
  // while lastRefreshMs had already been advanced — so the caller that
  // discovered it threw honestly and every caller for the next fifteen minutes
  // got live: true, no notice, and no retry. The recognised failure had a
  // notice and a two-minute retry; the unrecognised one had the cleanest
  // output the module can produce and the longest possible silence.
  ingest([rec()]);
  let calls = 0;
  const bugInOurOwnCode = async () => { calls += 1; throw new TypeError('locations is not iterable'); };
  const now = Date.now();

  // The discovering caller still throws: an untagged rejection is a defect in
  // this module, and lib/cache.js's catch is what logs it with its stack and
  // falls back to the last good payload. Losing that would trade one silence
  // for another.
  await assert.rejects(
    () => fetchNews(SYDNEY, { refresh: bugInOurOwnCode, now }),
    (err) => err instanceof TypeError && /locations is not iterable/.test(err.message)
  );
  assert.equal(calls, 1);

  const next = await fetchNews(SYDNEY, { refresh: bugInOurOwnCode, now: now + 1_000 });
  assert.equal(calls, 1, 'still inside the interval, so refresh must not re-run');
  assert.equal(next.live, false, 'an unrecognised failure is not a live layer');
  assert.ok(next.notice, 'and it is not silent');
  assert.match(next.notice, /locations is not iterable/, 'the failure detail reaches the notice');
  // Separable from an upstream outage on sight: nothing here established
  // anything about GDELT.
  assert.doesNotMatch(next.notice, /upstream unreachable/i);

  // And it degrades to the SHORTER retry, like any other failure — the whole
  // point of recording it. At REFRESH_INTERVAL_MS this call would still be
  // inside the interval and refresh would never be re-attempted.
  const retried = await fetchNews(SYDNEY, {
    refresh: async () => ({ added: 0 }),
    now: now + RETRY_INTERVAL_MS + 1_000,
  });
  assert.equal(retried.live, true, 'the retry interval engages and a working refresh clears the state');
  assert.ok(RETRY_INTERVAL_MS < REFRESH_INTERVAL_MS, 'which is only a shorter retry if it is shorter');
});

test('a caller arriving during the first refresh waits for the window instead of reporting it empty', async () => {
  // Cold start with two regions polled inside the ~2.2 s the bulk fetch takes.
  // The bystander fails the refresh gate (the slot was claimed synchronously),
  // and used to fall through with window_records: 0, live: true and "No
  // geocoded coverage for this region in the last 24 hours" — a false claim
  // that lib/cache.js then cached for its TTL and archived into the 48-hour
  // replay.
  let started = 0;
  const slowRefresh = async () => {
    started += 1;
    await new Promise((r) => setTimeout(r, 50));
    ingest([rec()]);
    return { added: 1 };
  };
  const now = Date.now();

  const [claimer, bystander] = await Promise.all([
    fetchNews(SYDNEY, { refresh: slowRefresh, now }),
    fetchNews({ id: 'sydney-2', bbox: SYDNEY.bbox }, { refresh: slowRefresh, now }),
  ]);

  assert.equal(started, 1, 'the bystander joins the refresh already in flight, it does not start a second download');
  assert.equal(claimer.features.length, 1);
  assert.equal(bystander.features.length, 1, 'the bystander sees the window the claimer paid for');
  assert.equal(bystander.window_records, 1);
  assert.equal(bystander.notice, undefined, 'and makes no claim about coverage it had not yet loaded');
});

test('the refresh cadence runs on the real clock, not on a clock the caller supplies', async () => {
  // `now` opens the gate for the call that passes it; it must not be written
  // into the shared cadence. A caller handing in a stale `now` would otherwise
  // leave lastRefreshMs an interval in the past and the very next call would
  // refresh again — one poll per interval quietly becoming two.
  let calls = 0;
  const counting = async () => { calls += 1; return { added: 0 }; };

  await fetchNews(SYDNEY, { refresh: counting, now: Date.now() - 10 * REFRESH_INTERVAL_MS });
  assert.equal(calls, 1);

  await fetchNews(SYDNEY, { refresh: counting });
  assert.equal(calls, 1, 'the gate closed against the real clock, so the second call must not refresh');
});

test('a region news query filters the bbox window to matching records only', async () => {
  const now = Date.now();
  const port = rec({ id: 'port1', title: 'Port of Sydney expansion approved', organisations: [] });
  const ferry = rec({ id: 'ferry1', title: 'Ferry service disruptions over the weekend', organisations: [] });
  const bird = rec({ id: 'bird1', title: 'Kookaburras flock to the park', organisations: [] });
  ingest([port, ferry, bird]);

  const region = { ...SYDNEY, params: { news: { query: 'port OR ferry' } } };
  const fc = await fetchNews(region, { refresh: async () => ({ added: 0 }), now });

  const ids = fc.features.map((f) => f.properties.title).sort();
  assert.deepEqual(ids, ['Ferry service disruptions over the weekend', 'Port of Sydney expansion approved']);
});

test('the world news query matches any of its OR\'d topics', async () => {
  const now = Date.now();
  const query = '(earthquake OR election OR conflict OR flood OR wildfire OR summit OR protest)';
  const earthquake = rec({ id: 'eq1', title: 'Magnitude 6.4 earthquake rocks the region', organisations: [] });
  const summit = rec({ id: 'sum1', title: 'Leaders gather for the climate summit', organisations: [] });
  ingest([earthquake, summit]);

  const fc = await fetchNews({ ...SYDNEY, params: { news: { query } } }, { refresh: async () => ({ added: 0 }), now });

  const ids = fc.features.map((f) => f.properties.title).sort();
  assert.deepEqual(ids, ['Leaders gather for the climate summit', 'Magnitude 6.4 earthquake rocks the region']);
});

test('a record matching none of the news query topics is dropped', async () => {
  const now = Date.now();
  const query = '(earthquake OR election OR conflict OR flood OR wildfire OR summit OR protest)';
  const cricket = rec({ id: 'cric1', title: 'Australia win the test match in five days', organisations: [] });
  ingest([cricket]);

  const fc = await fetchNews({ ...SYDNEY, params: { news: { query } } }, { refresh: async () => ({ added: 0 }), now });

  assert.equal(fc.features.length, 0, 'a record on no query topic is filtered out');
});

test('a record missing organisations does not crash the filter, it just fails to match', async () => {
  // ingest() only requires an id, so a store-legal record can reach the filter
  // without organisations. The unguarded `.concat` this regression guards
  // against threw, taking the whole news layer down for every region with a
  // query — the one filter-path line missing the || [] guard every sibling
  // uses.
  const now = Date.now();
  const { organisations, ...noOrgs } = rec({ id: 'noorgs', title: 'Magnitude 6.4 earthquake rocks the region' });
  ingest([noOrgs]);
  const query = '(earthquake OR election)';

  const fc = await fetchNews({ ...SYDNEY, params: { news: { query } } }, { refresh: async () => ({ added: 0 }), now });

  assert.equal(fc.features.length, 1, 'the matching record is served, the filter does not throw');
  assert.equal(fc.features[0].properties.title, 'Magnitude 6.4 earthquake rocks the region');
});

test('a query term with a regex metacharacter is matched literally, not thrown on', async () => {
  // A curated config is a string a human edits, so a stray '[' or '*' is a
  // matter of when, not whether. Unescaped, it made new RegExp throw and the
  // whole news layer went down for every region using that query. Escaped, the
  // bracket is literal text: it matches nothing (no title contains '['), the
  // other terms still match, and nothing throws.
  const now = Date.now();
  const plain = rec({ id: 'pln1', title: 'Magnitude 3.1 earthquake near the coast', organisations: [] });
  ingest([plain]);
  const query = '(line[4 OR earthquake)';

  const fc = await fetchNews({ ...SYDNEY, params: { news: { query } } }, { refresh: async () => ({ added: 0 }), now });

  assert.equal(fc.features.length, 1, 'the bracketed term is a literal no-match, not a crash');
  assert.equal(fc.features[0].properties.title, 'Magnitude 3.1 earthquake near the coast', 'the other OR-term still matches');
});
