// test/corpus-search-route.test.js
//
// The corpus search route is the first place the semantic layer is exposed over
// HTTP, so it is the first place the case boundary can be lost. The defect this
// file exists to catch does not look like a failure: the route reads a caseIds
// parameter, results come back, they are well ranked, and they are someone
// else's material.
//
// THE REAL ROUTE IS IMPORTED HERE, not a copy of its logic. Route modules
// resolve their imports through the "@/" alias in jsconfig.json, which bare node
// does not understand, and the usual workaround is to scan the route's source
// text instead (test/status-notice.test.js does that for app/page.jsx, which is
// JSX and genuinely cannot be imported). A source scan cannot catch a route that
// calls the right function and discards the result, and that is exactly the
// class of defect that matters here. So the alias is resolved with a loader hook
// registered as a data URL — the same technique test/ontology-route.test.js uses
// for JSON import attributes, and it adds no dependency.
//
// Two things the hook has to get right, both verified on 2026-08-17 before this
// file was written:
//
//   - Extensions. Every route in app/api writes `from '@/lib/db'` with no
//     extension, because Next resolves it. ESM does not: mapping `@/lib/db`
//     straight to <root>/lib/db fails with ERR_MODULE_NOT_FOUND. The hook probes
//     the candidates the bundler would.
//   - Module identity. The seam below reaches lib/db.js by absolute file URL
//     while this file and lib/corpus/scope.js reach it relatively. Those resolve
//     to the same URL and therefore the same module instance, which is what lets
//     a fixture written here be visible to the scope builder — lib/db.js keeps
//     the file backend's contents in module-level memory.
//
// WHAT THIS FILE CANNOT SEE. Two functions are replaced by seams — `semanticPool`
// as the route imports it, and `listWorkspaces` as lib/corpus/scope.js imports it
// — so the route's real call into lib/db.js is only exercised by the
// no-corpus-store test below. Both seams delegate to the real module unless a
// test installs something, and both reach it by the same URL this file does, so
// the fixtures are shared rather than duplicated. `globalThis.fetch` is blocked
// for the whole file, so the dense-retrieval and rerank legs of
// lib/corpus/search.js always degrade here; their working behaviour is pinned by
// test/corpus-search-integration.test.js against a real database. Nothing in this
// file reaches a network or a database.
//
// Import discipline follows test/db.test.js and test/guard.test.js: DATABASE_URL
// removed and cwd moved to a throwaway directory before anything pulling in
// lib/db.js is imported, because it picks its backend and its file path at import
// time. PHILOTAS_OPEN_READ is removed too — left set by the surrounding shell it
// would switch off the read gate the refusal test is about.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
// `bge_8005` is the service identity the adapter composes from the host; every
// stub in this file routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';

const repoRootUrl = pathToFileURL(path.join(import.meta.dirname, '..') + path.sep).href;
const realDatabaseModuleUrl = new URL('lib/db.js', repoRootUrl).href;

// The first of two seams, both defined below. lib/db.js's file backend answers
// null for semanticPool by design, so without this there is no way to watch what
// the route hands to retrieval — and what it hands to retrieval is the whole
// point. It delegates to the real function unless a test installs a pool, so the
// route's own degraded path stays testable through the real module.
const semanticPoolSeamSource = `
  import { semanticPool as realSemanticPool } from ${JSON.stringify(realDatabaseModuleUrl)};
  export async function semanticPool() {
    const seam = globalThis.__philotasCorpusRouteSeam;
    if (!seam) return realSemanticPool();
    seam.semanticPoolCalls += 1;
    if (seam.pool !== undefined) return seam.pool;
    return realSemanticPool();
  }
`;
const semanticPoolSeamUrl = `data:text/javascript,${encodeURIComponent(semanticPoolSeamSource)}`;

// The second seam, and the only way to reach the one path in this route that has
// no other observable: lib/corpus/scope.js lets a workspace-lookup failure
// propagate on purpose, and this route deliberately does not catch it. On the
// file backend that lookup cannot fail, so without an injected failure a route
// that wrapped sessionScope in a catch and invented an empty scope would look
// identical to one that did not. scope.js imports the lister RELATIVELY, so this
// is keyed on the importing module rather than on the specifier alone — lib/auth.js
// reaches the same datastore by its own relative path and must keep the real one,
// or the session cookie would stop resolving.
const workspaceListerSeamSource = `
  import { listWorkspaces as realListWorkspaces } from ${JSON.stringify(realDatabaseModuleUrl)};
  export async function listWorkspaces(user) {
    const seam = globalThis.__philotasCorpusRouteSeam;
    if (seam && seam.workspaceLookupFailure) throw seam.workspaceLookupFailure;
    return realListWorkspaces(user);
  }
`;
const workspaceListerSeamUrl = `data:text/javascript,${encodeURIComponent(workspaceListerSeamSource)}`;

const aliasResolverSource = `
  import fs from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const repoRootUrl = ${JSON.stringify(repoRootUrl)};
  const overrides = ${JSON.stringify({ '@/lib/db': semanticPoolSeamUrl })};
  const relativeOverrides = ${JSON.stringify([
    { specifier: '../db.js', importedBy: 'lib/corpus/scope.js', url: workspaceListerSeamUrl },
  ])};
  export async function resolve(specifier, context, nextResolve) {
    for (const override of relativeOverrides) {
      if (specifier === override.specifier && (context.parentURL || '').endsWith(override.importedBy)) {
        return { url: override.url, shortCircuit: true };
      }
    }
    if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
    if (overrides[specifier]) return { url: overrides[specifier], shortCircuit: true };
    const base = new URL(specifier.slice(2), repoRootUrl).href;
    // The candidates Next would try, in its order. A directory must not match,
    // or '@/lib/corpus' would resolve to the folder.
    for (const candidate of [base, \`\${base}.js\`, \`\${base}/index.js\`]) {
      const candidatePath = fileURLToPath(candidate);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return { url: candidate, shortCircuit: true };
      }
    }
    // Deliberately handed back to Node rather than resolved to something
    // plausible: an alias this hook cannot place must name itself in the error.
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(aliasResolverSource)}`, import.meta.url);

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let previousOpenRead;
let previousFetch;

let routeModule;
let GET;
let createUser;
let startSession;
let listWorkspaces;
let analyst;
let analystSessionToken;
let ownCase;
let strangerCase;
let sharedWithAnalystCase;

// A single before() hook, deliberately not split in two: node:test runs multiple
// top-level before() hooks in the same file concurrently rather than in
// registration order, so splitting "chdir + import" from "seed fixtures" would
// race the import against the seed. Same note as test/db.test.js.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-corpus-route-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  // Set to a deliberately unusable value first, then deleted, so the delete is
  // proven on a developer box too rather than being a line that only matters
  // where nobody looks. Nothing dials it: the Postgres backend connects lazily
  // and the first test asserts the file backend took the fixtures.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect';
  delete process.env.DATABASE_URL;

  previousOpenRead = process.env.PHILOTAS_OPEN_READ;
  delete process.env.PHILOTAS_OPEN_READ;

  // lib/embed.js and lib/rerank.js resolve their hosts from the @axoquant/llm
  // registry, which holds real internal URLs. On a developer laptop those are
  // unreachable; on the reference deployment they would answer. Neither is acceptable in a unit
  // test, so the single fetch call site in the shared client is cut off here.
  // Both wrappers turn the failure into an `.unavailable` error, which is what
  // lib/corpus/search.js degrades on by name.
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (resource) => {
    throw new Error(`no network in tests (blocked ${resource})`);
  };

  process.chdir(tempDir);

  ({ createUser, startSession } = await import('../lib/auth.js'));
  const database = await import('../lib/db.js');
  listWorkspaces = database.listWorkspaces;
  // The whole namespace, not just GET: the route's `dynamic` and `runtime`
  // exports are part of its behaviour and are asserted below.
  routeModule = await import('../app/api/corpus/search/route.js');
  GET = routeModule.GET;

  // First registered user is the admin, so register a throwaway one first and
  // make the analyst an ordinary operator at OFFICIAL — the shape that actually
  // runs in production.
  await createUser('route-admin', 'not-a-real-password-1');
  analyst = await createUser('route-analyst', 'not-a-real-password-2', { role: 'operator', clearance: 1 });
  analystSessionToken = await startSession(analyst.id);

  ownCase = await database.upsertWorkspace({
    ownerId: analyst.id, name: 'Botany berth incident', data: {},
    visibility: 'private', classification: 1, sharedWith: [],
  });
  // The bait. Byte-identical to ownCase in every field the datastore records
  // except the owner, so its absence from the predicate cannot be blamed on a
  // different name, classification or visibility.
  strangerCase = await database.upsertWorkspace({
    ownerId: 'someone-else', name: 'Botany berth incident', data: {},
    visibility: 'private', classification: 1, sharedWith: [],
  });
  // Someone else's case, shared with this analyst by name. It has to be IN
  // scope, and it is also what makes the case count below discriminating: the
  // session holds two cases, so a route that replaced the scope with the one
  // case named in the URL would report one, and a route that merged them would
  // report three.
  sharedWithAnalystCase = await database.upsertWorkspace({
    ownerId: 'someone-else', name: 'Kurnell jetty survey', data: {},
    visibility: 'private', classification: 1, sharedWith: ['route-analyst'],
  });
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousOpenRead === undefined) delete process.env.PHILOTAS_OPEN_READ;
  else process.env.PHILOTAS_OPEN_READ = previousOpenRead;
  globalThis.fetch = previousFetch;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const requestFor = (queryString, token) =>
  new Request(
    `http://localhost/api/corpus/search?${queryString}`,
    token ? { headers: { cookie: `philotas_session=${token}` } } : undefined
  );

// A pool that answers every query with `rowCount` fabricated chunks and keeps
// what it was asked. lib/corpus/search.js puts the case list in $1 and the
// clearance ceiling in $2 of BOTH legs, so this records the scope as it reaches
// the SQL rather than as the route chose to describe it.
const chunkRow = (index) => ({
  id: `chunk-in-scope-${index}`,
  doc_id: 'doc-in-scope',
  content: `The vessel OOCL SHANGHAI berthed at Brotherson Dock 10, paragraph ${index}.`,
});

function installRecordingPool({ rowCount = 1, queryFailure = null } = {}) {
  const recordedQueries = [];
  const seam = {
    recordedQueries,
    semanticPoolCalls: 0,
    pool: {
      async query(text, params) {
        recordedQueries.push({ text, params });
        // A plain Error, deliberately without the `.unavailable` tag that
        // lib/corpus/search.js degrades on: this is the shape of a real SQL
        // fault, which nothing in the retrieval path is entitled to absorb.
        if (queryFailure) throw queryFailure;
        return { rows: Array.from({ length: rowCount }, (unused, index) => chunkRow(index)) };
      },
    },
  };
  globalThis.__philotasCorpusRouteSeam = seam;
  return seam;
}

const removeSeam = () => { delete globalThis.__philotasCorpusRouteSeam; };

const asSortedSet = (ids) => [...ids].sort();

test('the fixtures went to the throwaway datastore, not a real one', async () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'a surviving DATABASE_URL would put these fixtures in a live database');
  assert.equal(process.env.PHILOTAS_OPEN_READ, undefined, 'the refusal test below is meaningless with the read gate switched off');

  const scratchDatastore = path.join(tempDir, '.data', 'philotas-db.json');
  assert.ok(
    fs.existsSync(scratchDatastore),
    'the file backend must be the one that took the fixtures, and it must be rooted in the temp dir'
  );
  assert.match(fs.readFileSync(scratchDatastore, 'utf8'), /route-analyst/);

  // Read unconditionally rather than under an `if (exists)`, so this assertion
  // runs on a clean checkout and in CI too. An absent file is itself a pass —
  // nothing reached a datastore that does not exist — and treating it as the empty
  // string says so without letting the check quietly skip.
  const realDatastore = path.join(originalCwd, '.data', 'philotas-db.json');
  const realDatastoreContents = fs.existsSync(realDatastore) ? fs.readFileSync(realDatastore, 'utf8') : '';
  assert.doesNotMatch(realDatastoreContents, /route-analyst/, 'a fixture reached the real datastore');
});

test('the route declares the runtime a session-scoped datastore read needs', async () => {
  // Neither export changes a single response, so nothing else in this file can
  // see them, and the build table showing `ƒ` is out-of-band from the suite. On a
  // per-client deployment a database-backed route that lost `runtime = 'nodejs'`
  // or got statically optimised would fail as an empty result rather than as an
  // error, which is the expensive direction for this particular route.
  assert.equal(routeModule.dynamic, 'force-dynamic', 'every response carries session scope and must never be prerendered');
  assert.equal(routeModule.runtime, 'nodejs', 'retrieval reaches pg and node:crypto through lib/db.js');
});

test('an unauthenticated request is refused before any scope is built', async () => {
  const seam = installRecordingPool();
  let res;
  try {
    res = await GET(requestFor('q=berth'));
  } finally {
    removeSeam();
  }

  assert.equal(res.status, 401);
  assert.equal(seam.semanticPoolCalls, 0, 'a refused caller must not reach the store at all');
  const body = await res.json();
  assert.equal(body.scope, undefined, 'a refusal carries no scope');
});

// ---------------------------------------------------------------------------
// The test that matters.
//
// A test asserting the caller sees its own results passes whether or not the
// scope predicate exists. This one asserts it cannot see another case's, on a
// bait that differs only by owner, and checks the bait was retrievable at all
// before reading anything into its absence. The observation point is the SQL
// parameter, which is the last place the case list can still be wrong.
test('a case named in the URL never reaches the SQL predicate', async () => {
  // Asserted here so a later edit to the fixtures cannot quietly turn the
  // exclusion below into a content difference.
  assert.equal(strangerCase.name, ownCase.name);
  assert.equal(strangerCase.visibility, ownCase.visibility);
  assert.equal(strangerCase.classification, ownCase.classification);
  assert.notEqual(strangerCase.ownerId, ownCase.ownerId);
  assert.notEqual(strangerCase.id, ownCase.id);

  // Non-vacuity: the bait is a real row the datastore hands back to the session
  // that holds it. Its absence below is the predicate working, not a fixture
  // that was never retrievable.
  const asItsOwnOwner = await listWorkspaces({ id: 'someone-else', username: 'someone-else', clearance: 1 });
  assert.ok(
    asItsOwnOwner.some((workspace) => workspace.id === strangerCase.id),
    'the bait must be retrievable, or this test proves nothing'
  );

  const seam = installRecordingPool();
  try {
    await GET(requestFor(`q=brotherson+dock&caseIds=${strangerCase.id}&clearance=3`, analystSessionToken));
  } finally {
    removeSeam();
  }

  // Non-vacuity again: a query really did reach the pool, so the parameters
  // below are evidence rather than an empty set.
  assert.ok(seam.recordedQueries.length > 0, 'no query reached the pool, so nothing below is evidence');

  for (const { params } of seam.recordedQueries) {
    assert.deepEqual(
      asSortedSet(params[0]),
      asSortedSet([ownCase.id, sharedWithAnalystCase.id]),
      'the case predicate is exactly the session\'s cases'
    );
    assert.ok(!params[0].includes(strangerCase.id), 'naming a case in the URL does not add it to the predicate');
    assert.equal(params[1], 1, 'the clearance ceiling is the session\'s, not the requested 3');
  }

  // Belt and braces: the bait's id appears in no parameter of any query, in any
  // position, however the route might have smuggled it through.
  assert.ok(
    !JSON.stringify(seam.recordedQueries).includes(strangerCase.id),
    'the bait case id reached the datastore somewhere in the query'
  );
});

test('the response says how many cases were searched and never which', async () => {
  // Echoing the case ids was justified on the grounds that they are the
  // caller's own. That holds today and stops holding the moment scope includes
  // an id the caller would not otherwise learn — a case inherited through a
  // team, a group share. The count answers the operator's question ("was my
  // search scoped, and to how much?") without being a disclosure channel.
  const seam = installRecordingPool();
  let body;
  try {
    const res = await GET(requestFor(`q=berth&caseIds=${strangerCase.id}&clearance=3`, analystSessionToken));
    body = await res.json();
  } finally {
    removeSeam();
  }

  // Tied to the scope that actually reached the SQL, not only to a literal, so
  // the reported count cannot drift from the searched set. The literal is kept
  // beside it because it pins the fixture shape the test below depends on — and
  // note that neither assertion alone can tell `caseIds.length` from a constant
  // `2`; the zero-case session at the end of this file is what does that.
  assert.equal(
    body.scope.caseCount,
    seam.recordedQueries[0].params[0].length,
    'the count reported is the size of the case list that was searched'
  );
  assert.equal(body.scope.caseCount, 2, 'the session holds its own case and the one shared with it, and nothing else');
  assert.equal(body.scope.clearance, 1, 'the requested clearance never reaches the scope');
  assert.equal(body.scope.caseIds, undefined, 'the scope must not name the cases it searched');

  const serialised = JSON.stringify(body);
  for (const [label, id] of [['own', ownCase.id], ['shared', sharedWithAnalystCase.id], ['stranger', strangerCase.id]]) {
    assert.ok(!serialised.includes(id), `the ${label} case id is disclosed in the response body`);
  }
});

test('the hits and the degradation retrieval reported are the ones served', async () => {
  // The defect a source scan cannot see: a route that calls searchChunks and
  // then answers with something of its own. Both fields have to arrive intact.
  const seam = installRecordingPool();
  let body;
  try {
    const res = await GET(requestFor('q=brotherson+dock', analystSessionToken));
    body = await res.json();
  } finally {
    removeSeam();
  }

  assert.equal(body.q, 'brotherson dock', 'the query is echoed as it was searched');
  assert.equal(body.hits.length, 1);
  assert.equal(body.hits[0].id, chunkRow(0).id);
  assert.equal(body.hits[0].doc_id, chunkRow(0).doc_id);
  assert.equal(body.hits[0].content, chunkRow(0).content);
  assert.equal(typeof body.hits[0].score, 'number');

  // The EXACT key set, not a check that four fields are present. A hit out of
  // lib/corpus/search.js also carries `rrf`, `dense_rank` and `lexical_rank` —
  // retrieval's working state, which reached every caller of this route until it
  // was projected away. Asserting presence is what let three fields drift in
  // silently; asserting the whole set means a field added upstream cannot rejoin
  // this response without failing here and being decided about.
  assert.deepEqual(
    Object.keys(body.hits[0]).sort(),
    ['content', 'doc_id', 'id', 'score'],
    'the response contract is these four fields and nothing else'
  );

  // Neither the embedder nor the reranker is reachable from a test, and
  // lib/corpus/search.js comma-joins both signals rather than letting the
  // second bury the first. A route that flattened `degraded` to a boolean, or
  // dropped it, fails here.
  assert.equal(body.degraded, 'no-dense-retrieval,no-rerank');
});

test('the response envelope is exactly five fields, and a sixth cannot arrive quietly', async () => {
  // The gap this closes was found on 2026-08-17: the assertion above pins the key
  // set of a HIT, and nothing pinned the top-level envelope. So the very drift the
  // route's projection exists to prevent — a field arriving from a layer below and
  // becoming part of this contract because nothing objected — was still open one
  // level up. `mixedEmbedModelExcluded` was added to the envelope in the same
  // change as this assertion, which is the declared-widening procedure the route's
  // own comment prescribes, applied to itself.
  const seam = installRecordingPool();
  let body;
  try {
    const res = await GET(requestFor('q=brotherson+dock', analystSessionToken));
    body = await res.json();
  } finally {
    removeSeam();
  }
  assert.deepEqual(
    Object.keys(body).sort(),
    ['degraded', 'hits', 'mixedEmbedModelExcluded', 'q', 'scope'],
    'the envelope contract is these five fields and nothing else'
  );
  assert.equal(seam.recordedQueries.length > 0, true, 'the search really ran, so this is not a pin over an early return');
});

test('a mixed-embedding-space count reaches the caller rather than stopping at the library', async () => {
  // The point of the guard behind this number: the dense leg now excludes chunks
  // embedded by a different service, so a case holding 900 chunks nobody
  // re-embedded returns nothing and looks to a user exactly like an empty case.
  // Left on searchChunks' return value the count satisfies the spec line and
  // defeats its purpose, because no operator ever sees it.
  //
  // `globalThis.fetch` is blocked for this whole file, so the embedder is
  // unreachable, the dense leg degrades and the count is never attempted — 0 is
  // the correct value here and what is being pinned is that the field is PRESENT
  // and numeric on the path a real search takes, not that a non-zero count
  // survives. The non-zero case is pinned against a stub pool in
  // test/corpus-search.test.js and against a real database in
  // test/corpus-search-integration.test.js.
  installRecordingPool();
  let body;
  try {
    const res = await GET(requestFor('q=brotherson+dock', analystSessionToken));
    body = await res.json();
  } finally {
    removeSeam();
  }
  assert.equal(typeof body.mixedEmbedModelExcluded, 'number', 'the count is a number, not a string or a missing key');
  assert.equal(body.mixedEmbedModelExcluded, 0);
  assert.equal(body.degraded, 'no-dense-retrieval,no-rerank', 'and the reason it is 0 is reported alongside it');
});


test('with no semantic store the route degrades by name instead of erroring', async () => {
  // The file backend offers no pool. An operator must be able to tell "the
  // corpus is not configured here" from "your search found nothing", and this
  // is the one test that reaches the real lib/db.js rather than the seam.
  //
  // Which makes that precondition load-bearing, so it is checked rather than
  // assumed. It holds today because node:test runs the top-level tests in a file
  // sequentially and every other test removes its seam in a `finally`. Add
  // concurrency to this file, or forget one `finally`, and this test would start
  // running against the seam while still passing — the seam delegates to the real
  // function when no pool is installed — and the header's claim about what is
  // covered here would quietly stop being true.
  assert.equal(globalThis.__philotasCorpusRouteSeam, undefined, 'this test must reach the real lib/db.js, not a seam');

  const res = await GET(requestFor('q=berth', analystSessionToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.hits, []);
  assert.equal(body.degraded, 'no-corpus-store');
  assert.equal(body.scope.caseCount, 2, 'a degraded answer still says what it would have searched');

  // This exit never calls searchChunks, and it still carries the same envelope.
  // A field present on some responses and absent on others is one every consumer
  // needs a guard for — the reasoning that put the count on all four of
  // searchChunks' own exits applies to the route's three as well.
  assert.equal(body.mixedEmbedModelExcluded, 0, 'no store means nothing was searched and so nothing was held back');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['degraded', 'hits', 'mixedEmbedModelExcluded', 'q', 'scope'],
    'the same envelope as a search that ran'
  );
});

test('a query shorter than two characters is answered without touching the store', async () => {
  const seam = installRecordingPool();
  let body;
  try {
    const res = await GET(requestFor('q=a', analystSessionToken));
    body = await res.json();
  } finally {
    removeSeam();
  }

  assert.deepEqual(body.hits, []);
  assert.equal(body.degraded, null, 'a short query is not a degradation, it is a non-question');
  assert.equal(seam.semanticPoolCalls, 0, 'the store was not even asked for a pool');
  assert.equal(seam.recordedQueries.length, 0);
  assert.equal(body.scope.caseCount, 2, 'the caller can still see the search would have been scoped');
  assert.equal(body.mixedEmbedModelExcluded, 0, 'nothing was searched, so nothing was held back');
  assert.deepEqual(
    Object.keys(body).sort(),
    ['degraded', 'hits', 'mixedEmbedModelExcluded', 'q', 'scope'],
    'the same envelope as a search that ran'
  );
});

test('the limit is honoured up to a ceiling and clamped past it', async () => {
  // With every candidate surviving fusion and the reranker unreachable,
  // lib/corpus/search.js returns candidates.slice(0, limit) — so the number of
  // hits is the limit the route passed down. 50 rows is LEG_LIMIT, the most
  // either leg can contribute.
  const asked = installRecordingPool({ rowCount: 50 });
  let clamped;
  try {
    const res = await GET(requestFor('q=berth&limit=1000', analystSessionToken));
    clamped = await res.json();
  } finally {
    removeSeam();
  }
  assert.equal(clamped.hits.length, 25, 'an outsized limit is clamped, not passed through');
  assert.ok(asked.recordedQueries.length > 0);

  installRecordingPool({ rowCount: 50 });
  let honoured;
  try {
    const res = await GET(requestFor('q=berth&limit=3', analystSessionToken));
    honoured = await res.json();
  } finally {
    removeSeam();
  }
  assert.equal(honoured.hits.length, 3, 'a reasonable limit is honoured, so the clamp is not just a constant');

  installRecordingPool({ rowCount: 50 });
  let defaulted;
  try {
    const res = await GET(requestFor('q=berth&limit=not-a-number', analystSessionToken));
    defaulted = await res.json();
  } finally {
    removeSeam();
  }
  assert.equal(defaulted.hits.length, 10, 'an unparseable limit falls back to the default rather than to none');
});

test('a scope that cannot be established fails visibly, not as an empty search', async () => {
  // The failure mode this guards is the tempting one: catch the rejection, carry
  // on with no cases, answer 200 with nothing found. That response is
  // indistinguishable from a search that legitimately matched nothing, so an
  // operator would read a broken datastore as a quiet corpus. lib/corpus/scope.js
  // documents the propagation at its foot; this is the route half of it.
  const seam = installRecordingPool();
  try {
    // Control first, so the rejection below is attributable to the injected
    // failure and not to anything else about this request.
    const before = await GET(requestFor('q=berth', analystSessionToken));
    assert.equal(before.status, 200, 'this exact request succeeds while the lookup works');

    seam.workspaceLookupFailure = new Error('workspace lookup unreachable');
    await assert.rejects(
      () => GET(requestFor('q=berth', analystSessionToken)),
      /workspace lookup unreachable/,
      'the route must not turn a failed scope lookup into an empty result'
    );
  } finally {
    removeSeam();
  }
});

test('a retrieval fault fails visibly too, and is not reported as nothing found', async () => {
  // The other half of the rule above, one layer down. lib/corpus/search.js
  // degrades by name for the two failures it expects — no embedder, no reranker
  // — and lets anything else through, because a SQL fault is not a degraded
  // answer, it is no answer. If this route caught it and served an empty result,
  // a broken chunk store would read as an empty corpus on every query.
  const control = installRecordingPool();
  try {
    const before = await GET(requestFor('q=berth', analystSessionToken));
    assert.equal(before.status, 200, 'this exact request succeeds while the store answers');
    assert.ok(control.recordedQueries.length > 0, 'the control really did reach the pool');
  } finally {
    removeSeam();
  }

  installRecordingPool({ queryFailure: new Error('relation "chunks" does not exist') });
  try {
    await assert.rejects(
      () => GET(requestFor('q=berth', analystSessionToken)),
      /relation "chunks" does not exist/,
      'the route must not turn a retrieval fault into an empty result'
    );
  } finally {
    removeSeam();
  }
});

test('a scope-bearing response is never cached', async () => {
  // Every response from this route carries the session's scope, so a shared
  // cache holding one and serving it to another session would disclose a count
  // that is not that session's. The degraded answers carry scope too.
  installRecordingPool();
  try {
    const res = await GET(requestFor('q=berth', analystSessionToken));
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a result response must not be cached');
  } finally {
    removeSeam();
  }

  const withoutStore = await GET(requestFor('q=berth', analystSessionToken));
  assert.equal(withoutStore.headers.get('cache-control'), 'no-store', 'the no-corpus-store answer must not be cached either');

  const shortQuery = await GET(requestFor('q=a', analystSessionToken));
  assert.equal(shortQuery.headers.get('cache-control'), 'no-store', 'the short-query answer must not be cached either');
});

test('a session holding no cases gets a named refusal to search, not an unscoped one', async () => {
  // The sharpest instance of the distinction this file exists to defend: an empty
  // result that is neither a failure nor a match. lib/corpus/search.js answers
  // 'no-scope' for an empty case list rather than dropping the predicate and
  // searching everything, and this route is what carries that signal to a caller.
  // This is the trial guest — a real viewer session holding no workspaces.
  //
  // It is also the only request in this file whose scope is not two cases at
  // clearance 1, which is what stops `caseCount` and the echoed `clearance` from
  // being indistinguishable from the constants 2 and 1.
  const guest = await createUser('route-guest', 'not-a-real-password-3', { role: 'viewer', clearance: 0 });
  const guestSessionToken = await startSession(guest.id);

  const seam = installRecordingPool();
  let body;
  let queriesFromGuest;
  try {
    // Non-vacuity: the datastore holds cases and the pool answers queries about
    // them. An empty result below is this guest holding nothing, not an empty
    // store or a pool that was never working.
    const asAnalyst = await GET(requestFor('q=berth', analystSessionToken));
    assert.equal((await asAnalyst.json()).scope.caseCount, 2, 'the store holds cases, they are just not this guest\'s');
    assert.ok(seam.recordedQueries.length > 0, 'the pool really does answer queries for a session that holds cases');

    const queriesBeforeGuest = seam.recordedQueries.length;
    const res = await GET(requestFor('q=berth', guestSessionToken));
    body = await res.json();
    queriesFromGuest = seam.recordedQueries.length - queriesBeforeGuest;
  } finally {
    removeSeam();
  }

  assert.equal(body.scope.caseCount, 0, 'no cases means none searched, not every case');
  assert.equal(body.scope.clearance, 0, 'and the lowest possible ceiling');
  assert.deepEqual(body.hits, []);
  assert.equal(body.degraded, 'no-scope', 'an empty scope is a named refusal to search, not a search that found nothing');
  // The failure this guards is the one that would leak across tenants: an empty
  // case list falling through to a query with no case predicate at all.
  assert.equal(queriesFromGuest, 0, 'an empty scope must not reach the store as an unscoped query');
});
