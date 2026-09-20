import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchHotspots } from '../lib/feeds/hotspots.js';
import { fetchCameras } from '../lib/feeds/cameras.js';
import { feedResultIsLive } from '../lib/feed-health.js';

// A feed says two separate things about itself: whether it has anything to
// report (`notice`) and whether what it is showing is current (`live`). The
// interface conflated them, inferring "not live" from the presence of a notice.
//
// The cost was concrete. The satellite layer notes that CelesTrak is
// unreachable while serving 109 live objects from the SatNOGS fallback, so a
// NOT LIVE banner sat over a layer that was working correctly — on the public
// trial, where a visitor has no way to tell a real warning from a bad one.

const withEnv = async (key, value, fn) => {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
};

test('a feed with no live imagery declares itself not live', async () => {
  await withEnv('CCTV_GEOJSON_URL', undefined, async () => {
    const fc = await fetchCameras({ bbox: null });
    assert.equal(fc.live, false);
    assert.ok(fc.notice, 'and says why');
    // The sites themselves are still real and still worth drawing.
    assert.ok(fc.features.length > 0, 'camera positions are served even without imagery');
  });
});

test('an unconfigured feed declares itself not live', async () => {
  await withEnv('FIRMS_MAP_KEY', undefined, async () => {
    const fc = await fetchHotspots({ bbox: null });
    assert.equal(fc.live, false);
    assert.match(fc.notice, /FIRMS/);
  });
});

// --------------------------------------------------------------- the API rule
//
// Both read routes report a combined `live` per feed: what the payload says
// about itself AND what lib/cache.js says about the age of an archived payload.
//
// Two tests used to sit here claiming to pin that. Neither imported anything.
// Both declared object literals in the test body and then asserted
// `payload.live !== false` against them — restating the rule rather than
// running it, so they held whatever the routes actually did. Four notice-related
// tests were in the suite when `b.notice ? 0 : b.count` shipped to the trial and
// two of them were these. The rule now lives in lib/feed-health.js, and these
// run it.

test('a feed that says nothing about liveness is reported live', () => {
  // Most payloads never mention the field: a satellite layer with nothing above
  // its horizon, a news layer with no geocoded coverage, a vessel layer over a
  // quiet bbox. Every one of those is live.
  assert.equal(feedResultIsLive({ payload: { type: 'FeatureCollection', features: [] }, live: true }), true);
  assert.equal(
    feedResultIsLive({
      payload: { type: 'FeatureCollection', features: [], notice: 'no vessels currently reported' },
      live: true,
    }),
    true,
    'having something to say about itself is not a claim about currency'
  );
  // Neither side mentions it — the cold-start entry lib/cache.js returns while
  // the first fetch is still in flight.
  assert.equal(feedResultIsLive({ payload: {}, stale: true, pending: true }), true);
});

test('a feed is not live when either the payload or the cache says so', () => {
  // The payload's own claim. lib/feeds/satellites.js sets this when every source
  // was unreachable and it is propagating from the element set on disk.
  assert.equal(
    feedResultIsLive({
      payload: { live: false, notice: 'Propagated from cached SatNOGS elements retrieved 41 min ago.' },
      live: true,
    }),
    false,
    'elements off the disk are not the newest that exist'
  );
  // The cache's claim, over a payload that thinks it is fine: an archived frame
  // with no successful poll behind it for twenty hours.
  assert.equal(feedResultIsLive({ payload: { live: true }, live: false }), false);
  assert.equal(feedResultIsLive({ payload: {}, live: false }), false, 'a silent payload does not overrule the cache');
  assert.equal(feedResultIsLive({ payload: { live: false }, live: false }), false);
});

test('a notice does not by itself make a feed not live', () => {
  // The satellite shape: a failed primary with a working fallback is live, and
  // still says so out loud. Inferring "not live" from the presence of a notice
  // is what put a NOT LIVE banner over a layer that was working.
  const onFallback = {
    payload: { live: true, notice: 'Live fetch failed: CelesTrak GP (UND_ERR_CONNECT_TIMEOUT).' },
    live: true,
  };
  assert.equal(feedResultIsLive(onFallback), true, 'a fallback that works is still live');
  assert.ok(onFallback.payload.notice, 'and the notice survives to be shown');
});

test('a missing feed result throws rather than being reported live', () => {
  // Deliberate, and the reason lib/feed-health.js does not reach for optional
  // chaining here. `feedResult?.payload?.live !== false` answers `true` for a
  // feed that is not there at all, and "absent reported as live" is the exact
  // failure the whole module exists to stop. Both routes always have an entry.
  assert.throws(() => feedResultIsLive(undefined), TypeError);
  assert.throws(() => feedResultIsLive({}), TypeError);
});

// ---------------------------------------------------------------- the routes
//
// A correct module that nothing calls fixes nothing, so BOTH ROUTES ARE RUN here
// and the `live` field of an actual response body is the observation point.
//
// The note that used to sit here said neither route was importable under bare
// `node --test`, because both resolve `@/lib/…` and only Next's bundler
// understands that. It was false, and this repo disproved it three times over
// while it was being written for the second time:
// test/corpus-search-route.test.js:50-125 registers a node:module resolve hook
// for the alias and imports app/api/corpus/search/route.js;
// test/ontology-route.test.js does the same; so does
// test/status-route-schema.test.js. The hook below is that same technique. The
// cost of the false premise was a source scan standing in for running the code:
// a route that called feedResultIsLive(r) and threw the answer away would have
// passed everything in this file.
//
// The scan is KEPT — see the note above it — because it catches something an
// import cannot: a route growing its own second copy of the rule. What was wrong
// was the reason it was the only check, not the check.
const ROUTES = ['../app/api/status/route.js', '../app/api/feeds/[feed]/route.js'];

const repoRoot = path.join(import.meta.dirname, '..');
const repoRootUrl = pathToFileURL(repoRoot + path.sep).href;
const realFeedHealthUrl = pathToFileURL(path.join(repoRoot, 'lib', 'feed-health.js')).href;

// Two keys, both real layers of the default region (asserted in before(), not
// assumed), so the status route's `(region.layers || []).filter(...)` does real
// work and the feeds route's FETCHERS lookup finds them.
const SEAMED_FEED_KEYS = ['vessels', 'weather'];
const STUB_FETCHED_AT_MS = 1755400000000;

// SEAM ONE: "@/lib/cache". The real getFeed() starts pollers and goes upstream,
// and every case below is about what the route DOES with a getFeed result rather
// than about fetching one. Each request is served the fixture the test installed.
const cacheSeamSource = `
  export const FETCHERS = ${JSON.stringify(Object.fromEntries(SEAMED_FEED_KEYS.map((k) => [k, 1])))};
  export async function getFeed(key, region) {
    const seam = globalThis.__philotasLivenessRouteSeam;
    seam.feedCalls.push({ key, regionId: region?.id });
    const result = seam.results[key];
    // Loud rather than empty: a missing fixture must not be servable as a feed
    // that simply had nothing to say, or a case that stopped installing one
    // would still assert something and pass.
    if (!result) throw new Error('no liveness fixture installed for feed ' + key);
    return result;
  }
`;
const cacheSeamUrl = `data:text/javascript,${encodeURIComponent(cacheSeamSource)}`;

// SEAM TWO: "@/lib/feed-health", and it DELEGATES. Every verdict on the wire
// below is the real lib/feed-health.js answer — the seam adds a call log and
// nothing else, so no assertion in this file reads a value a fake invented.
//
// Why the log exists at all. `feedResultIsLive` is character-identical to the
// inline `r.payload.live !== false && r.live !== false` this task is guarding
// against, so no response body can tell a route that calls the shared rule from
// a route that recomputes it. The log can: an inlined copy never reaches this
// function. That is the one thing here that is an interaction check rather than
// a behaviour check, and it is the only claim it is used for.
const feedHealthSeamSource = `
  import * as real from ${JSON.stringify(realFeedHealthUrl)};
  export const feedLiveness = real.feedLiveness;
  export const splitContactCounts = real.splitContactCounts;
  export function feedResultIsLive(feedResult) {
    const verdict = real.feedResultIsLive(feedResult);
    globalThis.__philotasLivenessRouteSeam.verdicts.push(verdict);
    return verdict;
  }
`;
const feedHealthSeamUrl = `data:text/javascript,${encodeURIComponent(feedHealthSeamSource)}`;

// The alias resolver, plus the JSON import-attribute shim test/ontology-route.test.js
// needs: lib/regions.js pulls sample JSON without an attribute and both routes
// reach it through getRegion().
const loaderSource = `
  import fs from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const repoRootUrl = ${JSON.stringify(repoRootUrl)};
  const overrides = ${JSON.stringify({ '@/lib/cache': cacheSeamUrl, '@/lib/feed-health': feedHealthSeamUrl })};
  export async function resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
    if (overrides[specifier]) return { url: overrides[specifier], shortCircuit: true };
    const base = new URL(specifier.slice(2), repoRootUrl).href;
    // The candidates Next would try, in its order. A directory must not match.
    for (const candidate of [base, \`\${base}.js\`, \`\${base}/index.js\`]) {
      const candidatePath = fileURLToPath(candidate);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return { url: candidate, shortCircuit: true };
      }
    }
    // Handed back to Node rather than resolved to something plausible: an alias
    // this hook cannot place must name itself in the error.
    return nextResolve(specifier, context);
  }
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let previousOpenRead;

let statusGet;
let feedGet;
let sessionToken;

// One before() hook, deliberately not split: node:test runs multiple top-level
// before() hooks in one file concurrently rather than in registration order, so
// splitting "chdir" from "import" would race the import against the chdir, and
// lib/db.js:76 reads process.cwd() at import time. Same note as
// test/register-error-disclosure.test.js.
//
// NOTHING HERE REACHES A DATABASE OR A NETWORK. DATABASE_URL is removed before
// lib/db.js is imported, which is the only moment it reads it, so the session
// fixture goes to the file backend in a temp directory. PHILOTAS_OPEN_READ is
// removed too: left set by the surrounding shell it would change which caller
// these responses are being served to.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-liveness-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  previousOpenRead = process.env.PHILOTAS_OPEN_READ;
  delete process.env.PHILOTAS_OPEN_READ;

  globalThis.__philotasLivenessRouteSeam = { feedCalls: [], verdicts: [], results: {} };

  process.chdir(tempDir);

  const { createUser, startSession } = await import('../lib/auth.js');
  const { getRegion } = await import('../lib/regions.js');
  const defaultRegion = getRegion(null);
  for (const key of SEAMED_FEED_KEYS) {
    assert.ok(
      (defaultRegion.layers || []).includes(key),
      `${key} is not a layer of ${defaultRegion.id}, so the status route would filter it out and report nothing`
    );
  }

  ({ GET: statusGet } = await import('../app/api/status/route.js'));
  ({ GET: feedGet } = await import('../app/api/feeds/[feed]/route.js'));

  // A viewer, which is the role a header strip and a public trial's guest
  // account run as. The role is passed rather than inherited from the
  // first-user rule so this fixture does not depend on registration order.
  const reader = await createUser('liveness-reader', 'not-a-real-password-1', { role: 'viewer', clearance: 0 });
  sessionToken = await startSession(reader.id);
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousOpenRead === undefined) delete process.env.PHILOTAS_OPEN_READ;
  else process.env.PHILOTAS_OPEN_READ = previousOpenRead;
  delete globalThis.__philotasLivenessRouteSeam;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const cookie = () => ({ headers: { cookie: `philotas_session=${sessionToken}` } });

function install(resultsByKey) {
  const seam = globalThis.__philotasLivenessRouteSeam;
  seam.results = resultsByKey;
  seam.verdicts = [];
  return seam;
}

async function statusFeeds() {
  const res = await statusGet(new Request('http://localhost/api/status?region=sydney', cookie()));
  assert.equal(res.status, 200, 'the session fixture was refused, so nothing below is about liveness');
  return (await res.json()).feeds;
}

async function feedBody(feed) {
  const res = await feedGet(new Request(`http://localhost/api/feeds/${feed}?region=sydney`, cookie()), {
    params: Promise.resolve({ feed }),
  });
  assert.equal(res.status, 200, 'the session fixture was refused, so nothing below is about liveness');
  return res.json();
}

// What getFeed() returns, and the verdict the routes must report for it. The
// expected value is a hand-written literal in every row — derived from the rule
// in lib/feed-health.js, never computed by calling it, so these rows pin the
// value rather than the formula.
const CASES = [
  {
    what: 'the cache overrules a payload that believes it is current',
    // An archived frame with no successful poll behind it for hours. The payload
    // it archived still says live:true, because it was true when it was written.
    result: {
      payload: { type: 'FeatureCollection', features: [{}, {}], live: true, source: 'stub-upstream' },
      at: STUB_FETCHED_AT_MS, live: false, stale: true, from_archive_ms: 72_000_000,
    },
    expected: false,
  },
  {
    what: 'the payload overrules a cache that believes the entry is current',
    // lib/feeds/satellites.js when every source was unreachable and it is
    // propagating from the element set on disk: fresh entry, stale data.
    result: {
      payload: {
        type: 'FeatureCollection', features: [{}],
        live: false, notice: 'Propagated from cached SatNOGS elements retrieved 41 min ago.',
      },
      at: STUB_FETCHED_AT_MS, live: true,
    },
    expected: false,
  },
  {
    what: 'a working fallback that has something to say is still live',
    // The satellite shape that put a NOT LIVE banner over a working layer.
    result: {
      payload: {
        type: 'FeatureCollection', features: [{}, {}, {}],
        live: true, notice: 'Live fetch failed: CelesTrak GP (UND_ERR_CONNECT_TIMEOUT).',
      },
      at: STUB_FETCHED_AT_MS, live: true,
    },
    expected: true,
  },
  {
    what: 'a payload that says nothing about liveness over a current entry is live',
    result: {
      payload: { type: 'FeatureCollection', features: [{}] },
      at: STUB_FETCHED_AT_MS, live: true,
    },
    expected: true,
  },
];

// KILLS: a status route that calls feedResultIsLive(r) and reports something
// else — `live: r.live` fails row 2, `live: r.payload.live !== false` fails row
// 1. Neither is reachable from the source scan below, which sees the call and
// stops there.
test('the status route reports the combined verdict on an actual response body', async () => {
  for (const { what, result, expected } of CASES) {
    install(Object.fromEntries(SEAMED_FEED_KEYS.map((key) => [key, result])));
    const feeds = await statusFeeds();

    assert.deepEqual(Object.keys(feeds).sort(), [...SEAMED_FEED_KEYS].sort(), 'the seamed feeds were not the ones reported');
    for (const key of SEAMED_FEED_KEYS) {
      assert.equal(feeds[key].live, expected, `${key}: ${what}`);
      // Non-vacuity: a real payload was served, so `live` is a verdict about
      // something rather than the default of an empty envelope.
      assert.equal(feeds[key].count, result.payload.features.length, `${key}: the fixture never reached the response`);
      assert.equal(feeds[key].fetched_at, STUB_FETCHED_AT_MS);
    }
  }
});

// KILLS: one verdict computed for a whole response and copied to every feed —
// which is what a route hoisting the call out of the per-feed map would produce.
test('two feeds in one status response get their own verdicts', async () => {
  const [cacheDead, , workingFallback] = CASES;
  assert.notEqual(cacheDead.expected, workingFallback.expected, 'this test needs two rows that disagree');

  install({ vessels: cacheDead.result, weather: workingFallback.result });
  const feeds = await statusFeeds();

  assert.equal(feeds.vessels.live, false, 'an archived frame the cache has given up on');
  assert.equal(feeds.weather.live, true, 'a working feed with something to say about itself');
});

// KILLS: the feeds route dropping `live: feedResultIsLive(r)` from AFTER the
// `...r.payload` spread. Row 1's payload carries `live: true` of its own, so a
// route that lets the spread win reports true where the rule says false — which
// is exactly the discard-the-result case, since the spread supplies a plausible
// answer and the discarded call is still there to satisfy the scan.
test('the feeds route reports the combined verdict on an actual response body', async () => {
  for (const { what, result, expected } of CASES) {
    install({ vessels: result });
    const body = await feedBody('vessels');

    assert.equal(body.live, expected, what);
    assert.equal(body.feed, 'vessels');
    assert.equal(body.count, result.payload.features.length, 'the fixture never reached the response');
    assert.equal(body.fetched_at, STUB_FETCHED_AT_MS);
  }

  // Spelled out because it is the property the ordering in that route exists
  // for: the payload's own claim was true and the answer served was false.
  const [cacheDead] = CASES;
  assert.equal(cacheDead.result.payload.live, true, 'the fixture stopped carrying a contradicting claim');
  assert.equal(cacheDead.expected, false);
});

// KILLS: restoring the inline `r.payload.live !== false && r.live !== false` to
// either route. It answers identically to lib/feed-health.js — that is what makes
// it survivable and what makes it dangerous — so no response body can catch it
// and only the call log can.
test('neither route decides liveness itself; both ask lib/feed-health.js at request time', async () => {
  const [cacheDead] = CASES;

  const seam = install(Object.fromEntries(SEAMED_FEED_KEYS.map((key) => [key, cacheDead.result])));
  const feedCallsBefore = seam.feedCalls.length;
  await statusFeeds();
  assert.equal(seam.feedCalls.length - feedCallsBefore, SEAMED_FEED_KEYS.length, 'the status route did not fetch both feeds');
  assert.deepEqual(
    seam.verdicts, SEAMED_FEED_KEYS.map(() => false),
    'the status route reached the shared rule once per feed, or it is deciding liveness itself'
  );

  install({ vessels: cacheDead.result });
  await feedBody('vessels');
  assert.deepEqual(
    globalThis.__philotasLivenessRouteSeam.verdicts, [false],
    'the feeds route reached the shared rule exactly once, or it is deciding liveness itself'
  );
});

// KEPT, and for a reason an import cannot cover: a route that grows a SECOND
// implementation of the rule alongside the call. Every case above would still
// pass — the served verdict is right and the shared rule was still asked — while
// the copy sits there waiting to drift, which is how one liveness rule has
// already diverged from another five times in this project (lib/feed-health.js
// header). Three properties here are load-bearing and none of them are
// incidental: `live: feedResultIsLive(r)` is pinned as the assignment, so a route
// that calls the rule and discards the answer fails; no `payload.live` may remain
// in executable code; and the comment stripper is guarded by a '://' assertion,
// so a route that grew a URL cannot silently start hiding code from the scan.
test('both read routes get the combined live verdict from lib/feed-health.js', () => {
  for (const relativePath of ROUTES) {
    const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
    // Only executable code is scanned; the comments in both files discuss the
    // rule at length and would match every pattern below. Stripping `//` to end
    // of line is safe only while neither file contains a URL, which is asserted
    // rather than assumed — a route that grew one would otherwise start hiding
    // code from this scan without saying so.
    assert.equal(source.includes('://'), false,
      `${relativePath} contains a URL; the comment stripper below would eat the rest of that line`);
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    assert.match(
      code,
      /import\s*\{[^}]*\bfeedResultIsLive\b[^}]*\}\s*from\s*'@\/lib\/feed-health'/,
      `${relativePath} must import the shared rule`
    );
    assert.match(code, /live:\s*feedResultIsLive\(\s*r\s*\)/, `${relativePath} must call it`);

    const offenders = code
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /payload\.live/.test(line));
    assert.deepEqual(
      offenders,
      [],
      `liveness has one implementation, in lib/feed-health.js; ${relativePath} decides it again:\n`
        + offenders.map(([n, line]) => `  ${n}: ${line.trim()}`).join('\n')
    );
  }
});
