import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { feedLiveness, splitContactCounts } from '../lib/feed-health.js';

test('a layer with a notice and live data counts as live', () => {
  // The satellite layer notes that its primary source is unreachable while
  // serving live positions from its fallback. Those positions are live. This is
  // the same rule the header chips and the not-live banner already follow, and
  // the footer was the one place still breaking it.
  const { liveContacts, degradedContacts } = splitContactCounts({
    satellites: {
      count: 91,
      notice: 'Live fetch failed: CelesTrak GP (HTTP 403).',
      live: true,
      error: null,
    },
  });
  assert.equal(liveContacts, 91);
  assert.equal(degradedContacts, 0);
});

test('a layer that declares itself not live counts as degraded', () => {
  const { liveContacts, degradedContacts } = splitContactCounts({
    transport: { count: 42, notice: null, live: false, error: null },
  });
  assert.equal(liveContacts, 0);
  assert.equal(degradedContacts, 42);
});

test('a failed poll over current data does not move the contacts it is showing', () => {
  // adsb.fi 503s on one poll while the cache still holds the last good payload.
  // lib/cache.js's refreshFeed catch produces exactly this: the payload it
  // already had, `error` set, `stale: true`, `from_archive_ms: null`, and
  // `live: true` because nothing came off disk and the feed was last known good
  // inside its TTL.
  //
  // The 120 aircraft on the screen are real aircraft. Filing them as not live
  // was the sixth instance of the defect at the top of lib/feed-health.js — one
  // field along from the notice one, and in the same direction: a working layer
  // reclassified by something that is not a statement about its data.
  const { liveContacts, degradedContacts } = splitContactCounts({
    aviation: { count: 120, notice: null, live: true, error: 'adsb.fi 503', stale: true, from_archive_ms: null },
  });
  assert.equal(liveContacts, 120);
  assert.equal(degradedContacts, 0);
});

test('a layer erroring with nothing to show is down, and has no contacts to file', () => {
  // The other half, and the reason `error` is still in the rule at all. A feed
  // that has never succeeded here returns `payload: EMPTY` with `live: true`,
  // since `live` is `archivedAt == null || …`. Liveness alone would call that
  // working. It contributes nothing to either contact column either way, which
  // is what lets the two consumers agree.
  const status = { transport: { count: 0, notice: null, live: true, error: 'TfNSW 401' } };
  assert.equal(feedLiveness(status.transport), 'down');
  assert.deepEqual(splitContactCounts(status), { liveContacts: 0, degradedContacts: 0 });
});

test('a cold-start layer answering from the archive still counts as live', () => {
  // lib/cache.js:290-302 serves the newest archived frame with `stale: true,
  // error: null` and a `live` verdict measured from when the feed was last
  // known good. For the first seconds after every restart that is EVERY layer
  // at once. Folding `stale` into the degraded rule — which is tempting,
  // because the header chip does turn amber on it — would put the whole
  // picture in the not-live column once a minute after each deploy.
  const { liveContacts, degradedContacts } = splitContactCounts({
    berths: { count: 18, notice: null, live: true, error: null, stale: true, from_archive_ms: Date.now() - 40_000 },
  });
  assert.equal(liveContacts, 18);
  assert.equal(degradedContacts, 0);
});

test('the two counts always partition the contacts, never drop or double them', () => {
  const status = {
    aviation: { count: 30, notice: 'No volunteer ADS-B feeder is in range…', live: true, error: null },
    satellites: { count: 109, notice: 'Primary source unreachable.', live: true, error: null },
    transport: { count: 42, notice: null, live: false, error: null },
    seismic: { count: 3, notice: null, live: true, error: null },
    news: { count: 0, notice: 'No geocoded coverage for this region.', live: true, error: null },
    fires: { count: 5, notice: null, live: true, error: 'upstream 503' },
  };
  const { liveContacts, degradedContacts } = splitContactCounts(status);
  const total = Object.values(status).reduce((a, b) => a + b.count, 0);
  assert.equal(liveContacts + degradedContacts, total);
  // fires is the failed-poll case: an error over five features the cache has
  // judged current. Only transport, which declares itself not live, is degraded.
  assert.equal(liveContacts, 30 + 109 + 3 + 5);
  assert.equal(degradedContacts, 42);
});

test('a layer that has not reported yet contributes nothing to either count', () => {
  // Two shapes have to survive this. A status object with a null count, which
  // is what a layer that has not answered looks like; and an object with no
  // count field at all, which components/MapView.jsx never writes today but
  // which page.jsx already defends against everywhere it reads a single feed
  // (`status[l.id] || {}`). Reading `status.count` unguarded turns the second
  // into NaN, and the footer renders it: "NaN live contacts".
  const { liveContacts, degradedContacts } = splitContactCounts({
    hotspots: { count: null, notice: null, live: true, error: null },
    weather: {},
  });
  assert.equal(liveContacts, 0);
  assert.equal(degradedContacts, 0);
  assert.ok(Number.isFinite(liveContacts) && Number.isFinite(degradedContacts));
});

test('a missing or empty status map is answered, not thrown on', () => {
  for (const empty of [undefined, null, {}]) {
    assert.deepEqual(splitContactCounts(empty), { liveContacts: 0, degradedContacts: 0 });
  }
});

test('a feed that has not reported is pending, not down', () => {
  // Counting a pending feed as dead is the same defect as marking a working
  // layer NOT LIVE. "Has not reported" means no entry at all — the phone header
  // has twelve chips to fill before the first poll answers.
  assert.equal(feedLiveness(undefined), 'pending');
  assert.equal(feedLiveness(null), 'pending');

  // The cold-start entry is a different thing and must not be swept in with it.
  // lib/cache.js returns `{ error: null, stale: true, pending: true }` when
  // nothing is cached and nothing is archived: the feed is answering, it just
  // has not finished. `live` is absent rather than false, so it reads live —
  // the same answer the rule that used to be inline in app/page.jsx gave.
  assert.equal(feedLiveness({ error: null, stale: true, pending: true }), 'live');
});

// ---------------------------------------------------------------------------
// The two consumers cannot disagree.
//
// They did. The footer's rule was `live === false || error`; the phone summary's
// was `live === false || (error && !(count > 0))`; the NOT LIVE banner's was
// `live === false` alone, and a comment in app/page.jsx claimed all three
// agreed. One failed poll over a warm cache put every contact in the degraded
// column while the summary beside it read "live" and no banner appeared.
//
// The fix is one implementation, not two rules kept in step by hand — but a
// second implementation could be reintroduced tomorrow, so this pins the
// agreement rather than the wording.
const MATRIX = [
  { label: 'live, quiet', st: { count: 5, live: true, error: null } },
  { label: 'live with a notice', st: { count: 91, live: true, error: null, notice: 'CelesTrak 403' } },
  { label: 'live from the archive on a cold start', st: { count: 18, live: true, error: null, stale: true, from_archive_ms: Date.now() - 40_000 } },
  { label: 'failed poll over a warm cache', st: { count: 120, live: true, error: 'adsb.fi 503', stale: true, from_archive_ms: null } },
  { label: 'declared not live', st: { count: 42, live: false, error: null } },
  { label: 'declared not live, from a stale frame', st: { count: 7, live: false, error: null, from_archive_ms: Date.now() - 3 * 3600_000 } },
  { label: 'erroring with nothing to show', st: { count: 0, live: true, error: 'TfNSW 401' } },
  { label: 'erroring and not live', st: { count: 3, live: false, error: 'GDELT timeout' } },
];

test('the footer and the phone summary reach the same verdict for every feed with contacts', () => {
  let withContacts = 0;
  for (const { label, st } of MATRIX) {
    const { liveContacts, degradedContacts } = splitContactCounts({ probe: st });
    const summary = feedLiveness(st);
    if (!(st.count > 0)) {
      assert.deepEqual({ liveContacts, degradedContacts }, { liveContacts: 0, degradedContacts: 0 },
        `${label}: a feed with no contacts must contribute to neither column`);
      continue;
    }
    withContacts++;
    const footer = degradedContacts > 0 ? 'down' : 'live';
    assert.equal(footer, summary,
      `${label}: the footer files these contacts as "${footer}" while the phone summary calls the feed "${summary}"`);
    assert.equal(liveContacts + degradedContacts, st.count, `${label}: contacts went missing`);
  }
  // Without this the matrix could lose every row with contacts and the loop
  // above would assert nothing about the agreement it exists to check. Seven of
  // the eight rows carry contacts; the eighth is the erroring feed with nothing
  // to show, which is the row that proves the two consumers agree by having
  // nothing to disagree about.
  assert.equal(withContacts, 7);
  assert.equal(MATRIX.length, 8);
});

test('the NOT LIVE banner rule agrees with both of them', () => {
  // The banner filters on `st.live === false` and is the third surface the
  // other two are supposed to match. For a feed with contacts, all three
  // reduce to that one field.
  for (const { label, st } of MATRIX) {
    if (!(st.count > 0)) continue;
    const banner = st.live === false ? 'down' : 'live';
    assert.equal(feedLiveness(st), banner,
      `${label}: the banner says "${banner}" and the summary says "${feedLiveness(st)}"`);
  }
});

// ---------------------------------------------------------------------------
// The consumer.
//
// Everything above pins lib/feed-health.js, and none of it can see the defect
// that is actually live on the trial, because that defect is a line of
// arithmetic inside app/page.jsx. A correct module that nothing imports fixes
// nothing — and this plan has already shipped tests that could not fail once.
//
// app/page.jsx is a `'use client'` JSX module behind the `@/` alias, so bare
// `node --test` cannot import it and there is no renderer available without
// adding a dependency. What can be checked without one is that the component
// asks lib/feed-health.js for the answer and does not keep a second, rival rule
// of its own. Reverting app/page.jsx:323-326 to the old reduce while leaving
// lib/feed-health.js untouched fails these two and nothing else in the suite.
const pageSource = readFileSync(fileURLToPath(new URL('../app/page.jsx', import.meta.url)), 'utf8');

// Comments in this file discuss `notice` and `count` in the same breath at
// length, and rightly so. Only executable code is scanned. page.jsx contains no
// `://` (checked), so stripping `//` to end of line cannot eat a URL.
const pageCode = pageSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

test('the footer gets its contact split from lib/feed-health.js', () => {
  assert.match(
    pageCode,
    /import\s*\{[^}]*\bsplitContactCounts\b[^}]*\}\s*from\s*'@\/lib\/feed-health'/,
    'app/page.jsx must import the shared rule'
  );
  assert.match(
    pageCode,
    /const\s*\{\s*liveContacts\s*,\s*degradedContacts\s*\}\s*=\s*splitContactCounts\(\s*status\s*\)/,
    'app/page.jsx must derive both footer totals from it, not recompute either'
  );
});

test('the phone summary gets its per-feed verdict from the same module', () => {
  // The other consumer of the same rule, and the one that had drifted. Deciding
  // it inline is how the footer and the summary came to disagree about a feed
  // whose poll had failed over a warm cache — and nothing in this file could see
  // it, because the second rule lived in a JSX module no test can import.
  assert.match(
    pageCode,
    /import\s*\{[^}]*\bfeedLiveness\b[^}]*\}\s*from\s*'@\/lib\/feed-health'/,
    'app/page.jsx must import the shared liveness rule'
  );
  assert.match(
    pageCode,
    /const\s+feedStates\s*=\s*activeDefs\.map\(\s*\(\s*l\s*\)\s*=>\s*feedLiveness\(/,
    'the per-feed summary must call feedLiveness, not decide liveness inline'
  );
  const offenders = pageCode
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /return\s*'(live|down|pending)'/.test(line));
  assert.deepEqual(
    offenders,
    [],
    'liveness has one implementation, in lib/feed-health.js; these lines decide it again:\n'
      + offenders.map(([n, line]) => `  ${n}: ${line.trim()}`).join('\n')
  );
});

test('app/page.jsx keeps no rule of its own that decides a count from a notice', () => {
  // Both patterns case-insensitively: `b.Notice ? 0 : b.count` is the same
  // defect, and a case-sensitive /notice/ would wave it through.
  const offenders = pageCode
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /notice/i.test(line) && /count/i.test(line));
  assert.deepEqual(
    offenders,
    [],
    'a notice says what a feed has to report, never how many of its contacts are real; '
      + 'these lines make a count depend on one:\n'
      + offenders.map(([n, line]) => `  ${n}: ${line.trim()}`).join('\n')
  );
});
