// test/status-route-schema.test.js
//
// A deployment whose semantic DDL was refused looks, from the outside, exactly
// like a healthy one: the map draws, the feeds are live, and retrieval returns
// nothing forever. lib/schema/startup.js records why that happened and exposes
// it through lastStartupResult(); until this file existed nothing read it, so
// the record was written and never shown.
//
// THE REAL ROUTE IS IMPORTED HERE, not a copy of its classification. That is the
// whole point of the file. test/liveness.test.js documents what the alternative
// costs: two tests sat there claiming to pin the combined liveness rule, both
// declared object literals in the test body and asserted the rule against them,
// and so both held whatever the routes actually did — one of them was in the
// suite when the notice bug shipped. A restatement of "already-applied is
// healthy" would pass against a route that classified by the boolean. So the
// route's own JSON is the observation point, every time.
//
// Route modules resolve their imports through the "@/" alias in jsconfig.json,
// which bare node does not understand. The loader hook below is the same
// technique test/corpus-search-route.test.js uses, plus the JSON import-attribute
// shim from test/ontology-route.test.js — lib/regions.js pulls sample-lake JSON
// without an attribute, and the route reaches it through getRegion().
//
// WHAT IS SEAMED AND WHY. Exactly one module: "@/lib/cache". The real getFeed()
// starts pollers and goes upstream, and this file is about the schema field, not
// the feeds. The seam registers two keys that are genuinely layers of the
// default region, so the route's real layer filter still runs and the `feeds`
// half of the envelope is really populated — which is what lets the assertions
// below prove the schema field was ADDED to the envelope rather than replacing
// it. lib/guard.js, lib/auth.js, lib/db.js, lib/regions.js, lib/feed-health.js
// and lib/schema/startup.js are all the real modules.
//
// NOTHING HERE REACHES A DATABASE OR A NETWORK. DATABASE_URL is removed before
// lib/db.js is imported, which is the only moment it reads it, so the file
// backend takes the fixtures. PARALLAX_OPEN_READ is removed too: left set by the
// surrounding shell it would switch off the gate the refusal test is about.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRootUrl = pathToFileURL(path.join(import.meta.dirname, '..') + path.sep).href;

// Two keys, both real layers of the default region (see lib/regions.js), so the
// route's `(region.layers || []).filter((key) => FETCHERS[key])` does real work.
const SEAMED_FEED_KEYS = ['vessels', 'weather'];
const STUB_FETCHED_AT_MS = 1755400000000;

// The two driver messages the degraded outcomes carry, as literals, because they
// are the needles the disclosure tests hunt for. A regex over a message this file
// writes itself is not a pin, so every assertion below uses the exact string.
//
// The host is from 203.0.113.0/24 (TEST-NET-3, reserved for documentation) so
// nothing here can be mistaken for a deployed address. What matters is that the
// substring exists at all: on a real deployment this fragment is the host and
// port of DATABASE_URL, read out of the unit environment by Node's connect error.
const POOL_FAILED_HOST_PORT = '203.0.113.7:5432';
const POOL_FAILED_DETAIL = `connect ECONNREFUSED ${POOL_FAILED_HOST_PORT}`;
// A refused DDL names a grant and an extension: internal configuration rather
// than a credential, lower severity than the line above, and on the same field.
const SCHEMA_FAILED_DETAIL = 'permission denied to create extension "vector"';

const cacheSeamSource = `
  export const FETCHERS = ${JSON.stringify(Object.fromEntries(SEAMED_FEED_KEYS.map((k) => [k, 1])))};
  export async function getFeed(key, region) {
    globalThis.__parallaxStatusRouteSeam.feedCalls.push({ key, regionId: region?.id });
    return {
      payload: { type: 'FeatureCollection', features: [{}, {}], source: 'stub-upstream' },
      at: ${STUB_FETCHED_AT_MS},
      live: true,
    };
  }
`;
const cacheSeamUrl = `data:text/javascript,${encodeURIComponent(cacheSeamSource)}`;

const loaderSource = `
  import fs from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const repoRootUrl = ${JSON.stringify(repoRootUrl)};
  const overrides = ${JSON.stringify({ '@/lib/cache': cacheSeamUrl })};
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

let routeModule;
let GET;
let ensureSemanticSchema;
let lastStartupResult;
let _resetStartupResult;
let sessionToken;
let operatorToken;
let adminToken;
let fixtureRoles;
let defaultRegionId;

// A single before() hook, deliberately not split: node:test runs multiple
// top-level before() hooks in one file concurrently rather than in registration
// order, so splitting "chdir + import" from "seed fixtures" would race the
// import against the seed. Same note as test/corpus-search-route.test.js.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-status-schema-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  previousOpenRead = process.env.PARALLAX_OPEN_READ;
  delete process.env.PARALLAX_OPEN_READ;

  globalThis.__parallaxStatusRouteSeam = { feedCalls: [] };

  process.chdir(tempDir);

  const { createUser, startSession } = await import('../lib/auth.js');
  ({ ensureSemanticSchema, lastStartupResult, _resetStartupResult } =
    await import('../lib/schema/startup.js'));
  const { getRegion } = await import('../lib/regions.js');
  defaultRegionId = getRegion(null).id;

  // The whole namespace, not just GET: `dynamic` and `runtime` are part of the
  // route's behaviour and are asserted below.
  routeModule = await import('../app/api/status/route.js');
  GET = routeModule.GET;

  // First registered user is the admin, so it is registered first and its role
  // comes from that rule rather than from an option. The reader is an ordinary
  // viewer — the shape a header strip runs as, and the shape a public trial's
  // guest account runs as.
  const admin = await createUser('status-admin', 'not-a-real-password-1');
  const reader = await createUser('status-reader', 'not-a-real-password-2', { role: 'viewer', clearance: 0 });
  const operator = await createUser('status-operator', 'not-a-real-password-3', { role: 'operator', clearance: 1 });
  sessionToken = await startSession(reader.id);
  operatorToken = await startSession(operator.id);
  adminToken = await startSession(admin.id);
  fixtureRoles = { admin: admin.role, viewer: reader.role, operator: operator.role };
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousOpenRead === undefined) delete process.env.PARALLAX_OPEN_READ;
  else process.env.PARALLAX_OPEN_READ = previousOpenRead;
  delete globalThis.__parallaxStatusRouteSeam;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const requestFor = (token) =>
  new Request(
    'http://localhost/api/status',
    token ? { headers: { cookie: `parallax_session=${token}` } } : undefined
  );

const statusBody = async (token = sessionToken) => (await GET(requestFor(token))).json();

// The bytes that actually leave the process. A field hidden from `schema` and
// spread into the envelope somewhere else would still pass an assertion on
// `schema.detail`, so the disclosure assertions read the serialised body.
const statusText = async (token = sessionToken) => (await GET(requestFor(token))).text();

// Counted, not matched. Asserting a needle occurs EXACTLY ONCE in the permitted
// response before hunting for zero in the withheld one is what separates
// "the mutation survived" from "the needle was never in the fixture at all".
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// SCHEMA_FAILED_DETAIL contains double quotes, which JSON escapes, so the raw
// string never appears in the bytes even when the field is served. A byte-level
// search has to look for the serialised form or it reads as zero either way —
// which is exactly the false pass this file is trying not to ship.
const onWire = (s) => JSON.stringify(s).slice(1, -1);

// lib/schema/startup.js logs the two degraded outcomes to console.error by
// design. Driving them here is setup, not the behaviour under test, so the log
// is swallowed to keep the suite output pristine — and restored immediately, so
// nothing else in this file can lose a real error.
// console.warn is swallowed too: lib/guard.js:26 logs once when
// PARALLAX_OPEN_READ=1 is first honoured, which the open-read test below has to
// trigger on purpose.
async function quietly(fn) {
  const realError = console.error;
  const realLog = console.log;
  const realWarn = console.warn;
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); }
  finally { console.error = realError; console.log = realLog; console.warn = realWarn; }
}

// Drives lib/schema/startup.js's REAL recorder into each outcome, rather than
// assigning a literal to a fake. Three of the six go through the real code path
// end to end: no-pool is startup.js's own branch, pool-failed is a rejected pool
// reaching its catch, and no-database is the real applySemanticSchema deciding
// it (DATABASE_URL is unset for this process, so it short-circuits at
// lib/schema/apply.js:16 before touching the pool). The other three need an
// applier stub: `applied: true` and 'already-applied' both require a database,
// and 'schema-failed' requires one that refuses the DDL.
const DRIVERS = {
  applied: () => ensureSemanticSchema({ pool: { id: 'stub-pool' }, apply: async () => ({ applied: true }) }),
  'already-applied': () => ensureSemanticSchema({
    pool: { id: 'stub-pool' },
    apply: async () => ({ applied: false, reason: 'already-applied' }),
  }),
  'no-pool': () => ensureSemanticSchema({ pool: null }),
  'no-database': () => ensureSemanticSchema({ pool: { id: 'stub-pool' } }),
  'pool-failed': () => ensureSemanticSchema({
    pool: Promise.reject(new Error(POOL_FAILED_DETAIL)),
  }),
  'schema-failed': () => ensureSemanticSchema({
    pool: { id: 'stub-pool' },
    apply: async () => { throw new Error(SCHEMA_FAILED_DETAIL); },
  }),
};

async function driveTo(reason) {
  _resetStartupResult();
  if (reason === null) return null;
  const recorded = await quietly(DRIVERS[reason]);
  // Non-vacuity: the recorder really did land on the outcome this case is
  // about. Without this a driver that drifted would silently test some other
  // reason and still pass.
  const recordedReason = recorded.applied === true ? 'applied' : recorded.reason;
  assert.equal(recordedReason, reason, `the driver for ${reason} recorded ${recordedReason}`);
  return recorded;
}

test('the fixtures went to the throwaway datastore, not a real one', async () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'a surviving DATABASE_URL would put these fixtures in a live database');
  assert.equal(process.env.PARALLAX_OPEN_READ, undefined, 'the refusal test below is meaningless with the read gate switched off');

  const scratchDatastore = path.join(tempDir, '.data', 'parallax-db.json');
  assert.ok(fs.existsSync(scratchDatastore), 'the file backend must be the one that took the fixtures');
  assert.match(fs.readFileSync(scratchDatastore, 'utf8'), /status-reader/);

  // Read unconditionally rather than under an `if (exists)`, so this runs on a
  // clean checkout and in CI too. An absent file is itself a pass.
  const realDatastore = path.join(originalCwd, '.data', 'parallax-db.json');
  const realContents = fs.existsSync(realDatastore) ? fs.readFileSync(realDatastore, 'utf8') : '';
  assert.doesNotMatch(realContents, /status-reader/, 'a fixture reached the real datastore');
});

test('the route still declares the runtime a datastore read needs', async () => {
  assert.equal(routeModule.dynamic, 'force-dynamic');
  assert.equal(routeModule.runtime, 'nodejs');
});

// ---------------------------------------------------------------- the mapping
//
// One case per value lastStartupResult() can hold, with the wire status written
// out as a literal beside it. The literals are hand-derived from the table in
// lib/schema/startup.js's header, NOT imported from the classifier — an
// assertion that imports the thing it checks pins the formula and never the
// value.
const WIRE = [
  ['applied', 'healthy', 'the schema was applied at boot'],
  // THE TRAP. lib/schema/apply.js:17 returns applied:false for a no-op, so a
  // correctly provisioned deployment restarting reports this on every boot after
  // its first. `if (!applied) → degraded` calls that broken.
  ['already-applied', 'healthy', 'the schema is already there'],
  ['no-pool', 'inactive', 'the file backend: no Postgres configured, nothing wrong'],
  ['no-database', 'inactive', 'a pool with no DATABASE_URL: nothing wrong'],
  ['pool-failed', 'degraded', 'Postgres would not accept a connection'],
  ['schema-failed', 'degraded', 'Postgres answered and refused the DDL'],
  // No boot attempt was ever recorded. Reporting that as healthy would be the
  // same silent failure one level up, so it gets a name of its own.
  [null, 'unknown', 'nothing was recorded at boot'],
];

test('every startup outcome reaches the wire with the status its meaning demands', async () => {
  for (const [reason, expectedStatus, why] of WIRE) {
    await driveTo(reason);
    const body = await statusBody();
    assert.equal(body.schema.status, expectedStatus, `${reason} is ${expectedStatus}: ${why}`);
    assert.equal(body.schema.reason, reason, `${reason} reaches the wire verbatim`);
  }
});

test('a no-op re-apply is never reported as broken', async () => {
  // Split out from the table because this is the defect the whole task exists to
  // prevent, and it should fail by name. A handler written as
  // `if (!applied) → degraded` fails here and passes every other row above
  // except the two inactive ones.
  const recorded = await driveTo('already-applied');
  assert.equal(recorded.applied, false, 'the healthy outcome really does carry applied:false');

  const body = await statusBody();
  assert.equal(body.schema.status, 'healthy');
  assert.notEqual(body.schema.status, 'degraded', 'an idempotent schema is not a fault');

  // Read on the OPERATOR body, because that is where `detail` exists at all now.
  // The distinction this pins: null means "you may see this field and there is
  // nothing in it", which is a different fact from the viewer's absent key.
  const operatorBody = await statusBody(operatorToken);
  assert.equal(operatorBody.schema.detail, null, 'a healthy outcome has nothing to explain');
});

test('the two degradations stay distinguishable FOR A VIEWER, because they send an operator elsewhere', async () => {
  // THE PROPERTY THAT HAD TO SURVIVE GATING `detail`. `reason` is what carries
  // the "which fault is it" distinction, which is exactly why a viewer keeps it:
  // if hiding the driver message had collapsed pool-failed and schema-failed into
  // one signal for the header strip, the fix would have undone what this file was
  // written for. So both halves are read off the VIEWER's body.
  await driveTo('pool-failed');
  const unreachable = (await statusBody()).schema;

  await driveTo('schema-failed');
  const refused = (await statusBody()).schema;

  // Both degraded — so a monitor watching one field still catches either.
  assert.equal(unreachable.status, 'degraded');
  assert.equal(refused.status, 'degraded');
  // And still separable, which is the part that matters: one is "wait, or fix
  // the network", the other is "fix a grant".
  assert.equal(unreachable.reason, 'pool-failed');
  assert.equal(refused.reason, 'schema-failed');
  assert.notEqual(unreachable.reason, refused.reason, 'the two degradations collapsed into one signal');
  assert.notDeepEqual(unreachable, refused, 'the two degradations are indistinguishable on the wire');

  // Neither driver message is any part of what the viewer received. The inverse
  // of what this line asserted before 2026-08-17: it read
  // `assert.match(unreachable.detail, /ECONNREFUSED/)` on the HTTP body, and so
  // documented the disclosure instead of catching it.
  assert.equal(unreachable.detail, undefined, 'the connection failure message reached a viewer');
  assert.equal(refused.detail, undefined, 'the refused-DDL message reached a viewer');
});

test('an operator gets the driver message a viewer is refused, on the same recorded state', async () => {
  // The operator surface must not lose the specific message: `reason` says which
  // of the two faults it is, `detail` says which host, which grant, which
  // extension. Gating it rather than dropping it is what keeps both.
  await driveTo('pool-failed');
  const unreachableText = await statusText(operatorToken);
  const unreachable = JSON.parse(unreachableText).schema;

  assert.equal(unreachable.status, 'degraded');
  assert.equal(unreachable.reason, 'pool-failed');
  // The literal, not a regex over it: the message is written in this file, so a
  // regex would hold against a truncated or redacted version of it.
  assert.equal(unreachable.detail, POOL_FAILED_DETAIL);
  assert.equal(
    occurrences(unreachableText, POOL_FAILED_HOST_PORT), 1,
    'the needle must be present exactly once here, or the zero asserted for a viewer proves nothing'
  );

  await driveTo('schema-failed');
  const refusedText = await statusText(operatorToken);
  const refused = JSON.parse(refusedText).schema;
  assert.equal(refused.reason, 'schema-failed');
  assert.equal(refused.detail, SCHEMA_FAILED_DETAIL);
  assert.equal(occurrences(refusedText, onWire(SCHEMA_FAILED_DETAIL)), 1);
});

test('an admin gets it too, because the gate is a rank and not an equality on one role name', async () => {
  // atLeast('admin', 'operator') is true (lib/auth.js:36). A gate written as
  // `user.role === 'operator'` passes the operator test above and fails here.
  assert.deepEqual(fixtureRoles, { admin: 'admin', viewer: 'viewer', operator: 'operator' },
    'the fixtures are not the three roles these tests claim to exercise');

  await driveTo('pool-failed');
  const text = await statusText(adminToken);
  assert.equal(JSON.parse(text).schema.detail, POOL_FAILED_DETAIL);
  assert.equal(occurrences(text, POOL_FAILED_HOST_PORT), 1);
});

// ------------------------------------------- what a withheld field looks like
//
// THE DECISION, PINNED: a withheld `detail` is an OMITTED KEY, never a null one.
//
// `detail: null` is already load-bearing in this envelope — 'applied',
// 'already-applied' and the unknown outcome genuinely have nothing to explain,
// and the tests above still assert that null for a caller cleared to see the
// field. If withholding produced null as well, a viewer reading
// { status: 'degraded', reason: 'pool-failed', detail: null } would conclude the
// boot recorded no explanation, when one exists and they may not see it. That is
// the silent-wrong this project keeps finding. An absent key says "not part of
// your view of this envelope"; null says "the field is yours and it is empty".
test('a viewer never receives the driver message, and the withheld field is an absent key', async () => {
  await driveTo('pool-failed');

  // Control first: an operator on this EXACT recorded state does get the needle,
  // so a failure below is attributable to the viewer's role rather than to the
  // driver having stopped producing a detail.
  const operatorText = await statusText(operatorToken);
  assert.equal(occurrences(operatorText, POOL_FAILED_HOST_PORT), 1, 'the fixture never carried the needle');

  const res = await GET(requestFor(sessionToken));
  assert.equal(res.status, 200, 'a viewer still reads the status surface');
  const text = await res.text();
  const schema = JSON.parse(text).schema;

  // What a viewer keeps.
  assert.equal(schema.status, 'degraded');
  assert.equal(schema.reason, 'pool-failed');

  // What a viewer must not get, asserted on the bytes rather than on the field.
  assert.equal(occurrences(text, POOL_FAILED_HOST_PORT), 0, 'the host and port of DATABASE_URL reached a viewer');
  assert.doesNotMatch(text, /ECONNREFUSED/, 'the driver message reached a viewer');

  // Omitted, not null. Both halves, because `'detail' in schema` alone would hold
  // for detail:undefined, which JSON.stringify drops and a non-JSON consumer
  // would not.
  assert.deepEqual(Object.keys(schema).sort(), ['reason', 'status'], 'a withheld detail must be an absent key');
  assert.equal(Object.hasOwn(schema, 'detail'), false, 'a withheld detail was serialised as a present key');
  assert.doesNotMatch(text, /"detail"/, 'the key itself is absent from the bytes a viewer receives');
});

test("a viewer is refused the refused-DDL message too, grants and extension names included", async () => {
  await driveTo('schema-failed');

  const operatorText = await statusText(operatorToken);
  assert.equal(occurrences(operatorText, onWire(SCHEMA_FAILED_DETAIL)), 1, 'the fixture never carried the needle');

  const text = await statusText(sessionToken);
  assert.equal(occurrences(text, onWire(SCHEMA_FAILED_DETAIL)), 0, 'the refused-DDL message reached a viewer');
  assert.doesNotMatch(text, /permission denied/, 'the grant failure reached a viewer');
  assert.equal(JSON.parse(text).schema.reason, 'schema-failed', 'and the reason still says which fault it is');
});

test('the open-read escape hatch does not hand the driver message to an anonymous caller', async () => {
  // lib/guard.js:18-29 and :43. PARALLAX_OPEN_READ=1 makes viewer-level reads
  // unauthenticated, so requireUser() returns user:null with no refusal — a gate
  // that defaulted an absent role to operator, or that only hid detail on the 401
  // path, would leak to the whole internet here.
  await driveTo('pool-failed');
  const operatorText = await statusText(operatorToken);
  assert.equal(occurrences(operatorText, POOL_FAILED_HOST_PORT), 1, 'the fixture never carried the needle');

  process.env.PARALLAX_OPEN_READ = '1';
  try {
    const res = await quietly(() => GET(requestFor(null)));
    assert.equal(res.status, 200, 'the escape hatch really was honoured, so this is the open path');
    const text = await res.text();
    assert.equal(occurrences(text, POOL_FAILED_HOST_PORT), 0, 'an anonymous caller read the host and port of DATABASE_URL');
    assert.doesNotMatch(text, /ECONNREFUSED/);
    const schema = JSON.parse(text).schema;
    assert.equal(schema.reason, 'pool-failed', 'the coarse verdict is still served on the open path');
    assert.equal(Object.hasOwn(schema, 'detail'), false);
  } finally {
    delete process.env.PARALLAX_OPEN_READ;
  }

  // The hatch really is off again, so nothing after this file's tests inherits it.
  assert.equal(process.env.PARALLAX_OPEN_READ, undefined);
  assert.equal((await GET(requestFor(null))).status, 401);
});

test('nothing recorded at boot is never reported as healthy', async () => {
  await driveTo(null);
  assert.equal(lastStartupResult(), null, 'the precondition really is an absent result');

  const body = await statusBody();
  assert.equal(body.schema.status, 'unknown');
  assert.notEqual(body.schema.status, 'healthy', 'an unread boot must not look like a successful one');
  assert.equal(body.schema.reason, null);
  // On the operator body, for the same reason as the already-applied case: null
  // is the value of a field you are cleared to see and that holds nothing.
  assert.equal((await statusBody(operatorToken)).schema.detail, null);
});

test('the handler reads the recorded result instead of applying the schema itself', async () => {
  // The second trap in lib/schema/startup.js's header. The already-applied guard
  // is module state, so a handler that applied rather than read would hit it on
  // the first request it serves — and on this process, with no DATABASE_URL, it
  // would overwrite the recorded outcome with 'no-pool' and report `inactive` for
  // a database that is genuinely refusing connections.
  const recorded = await driveTo('pool-failed');

  const body = await statusBody();
  assert.equal(body.schema.reason, 'pool-failed', 'the handler re-ran the apply and reported its own answer');
  assert.strictEqual(
    lastStartupResult(),
    recorded,
    'serving a status request replaced the boot record, so the handler applied rather than read'
  );

  // Twice, because the guard only bites on the SECOND call in a process: one
  // request could hide it.
  const again = await statusBody();
  assert.equal(again.schema.reason, 'pool-failed');
  assert.strictEqual(lastStartupResult(), recorded);
});

test('the schema outcome joined the existing envelope rather than displacing it', async () => {
  const before = globalThis.__parallaxStatusRouteSeam.feedCalls.length;
  await driveTo('applied');
  const body = await statusBody();

  assert.equal(body.region, defaultRegionId, 'the region is still reported');
  assert.equal(body.region, 'sydney', 'and the default really is the one this file exercises');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['feeds', 'region', 'schema'],
    'the envelope is these three fields and nothing else'
  );
  // A viewer's two fields, an operator's three. The key sets are the contract,
  // written out as literals in both directions so neither a dropped `detail` nor
  // an ungated one can pass.
  assert.deepEqual(
    Object.keys(body.schema).sort(),
    ['reason', 'status'],
    'a viewer sees these two fields and nothing else'
  );
  assert.deepEqual(
    Object.keys((await statusBody(operatorToken)).schema).sort(),
    ['detail', 'reason', 'status'],
    'an operator sees these three fields and nothing else'
  );

  // Non-vacuity for the feeds half: the seam was really asked, so `feeds` is
  // populated output rather than an empty object that would pass either way.
  assert.ok(globalThis.__parallaxStatusRouteSeam.feedCalls.length > before, 'no feed was fetched');
  assert.deepEqual(Object.keys(body.feeds).sort(), [...SEAMED_FEED_KEYS].sort());
  assert.equal(body.feeds.vessels.count, 2, 'the feed half of the envelope still carries real counts');
  assert.equal(body.feeds.vessels.live, true);
  assert.equal(body.feeds.vessels.fetched_at, STUB_FETCHED_AT_MS);
});

test('a status response is never cached', async () => {
  await driveTo('schema-failed');
  const res = await GET(requestFor(sessionToken));
  assert.equal(res.headers.get('cache-control'), 'no-store', 'a cached degraded verdict would outlive the fault');
});

test('an unauthenticated caller learns nothing about the schema', async () => {
  await driveTo('schema-failed');

  // The control first, so the refusal below is attributable to the missing
  // cookie and not to anything else about this request.
  const permitted = await statusBody();
  assert.equal(permitted.schema.reason, 'schema-failed', 'this exact state is visible to a session');

  const feedCallsBefore = globalThis.__parallaxStatusRouteSeam.feedCalls.length;
  const res = await GET(requestFor(null));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.schema, undefined, 'a refusal carries no schema outcome');
  assert.doesNotMatch(JSON.stringify(body), /vector/, 'and no boot detail either');
  assert.equal(
    globalThis.__parallaxStatusRouteSeam.feedCalls.length,
    feedCallsBefore,
    'a refused caller must be turned away before any work, so the guard is still the first statement'
  );
});
