// test/corpus-scope.test.js
//
// Case scope is the tenancy boundary of the whole semantic layer. An embedding
// is a lossy copy of the text it was made from, so a chunk that surfaces from
// another case is a disclosure whether or not the interface then hides it.
// This file is the only place that decides which cases a session can see.
//
// Every scope assertion here is negative or exact, because a test asserting
// that a session sees its OWN case passes whether or not the ownership
// predicate exists. So the fixtures include a case that is byte-identical to
// the analyst's own apart from its owner, and each negative assertion is
// preceded by a check that the bait was reachable at all — the discipline
// test/corpus-search-integration.test.js uses for chunk scope. An empty result
// from a fixture that was never visible proves nothing.
//
// Same import discipline as test/db.test.js and test/guard.test.js:
// DATABASE_URL removed and cwd moved to a throwaway directory before lib/db.js
// is imported, because it picks its backend and its file path at import time.
// PHILOTAS_OPEN_READ is removed too — left set by the surrounding shell it would
// switch off the read gate that the refusal test is about.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let previousOpenRead;
let sessionScope;
let createUser;
let startSession;
let upsertWorkspace;
let listWorkspaces;
let listUsers;

const requestWithSession = (token) =>
  new Request('http://localhost/api/corpus/search?q=x', {
    headers: { cookie: `philotas_session=${token}` },
  });

const requestWithoutSession = () =>
  new Request('http://localhost/api/corpus/search?q=x');

let analyst;
let analystToken;
let ownCase;
let strangerCase;
let sharedWithAnalystCase;

// A single before() hook, deliberately not split in two: node:test runs
// multiple top-level before() hooks in the same file concurrently rather than
// in registration order, so splitting "chdir + import" from "seed fixtures"
// would race the import against the seed. See the same note in test/db.test.js.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-scope-test-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  // Set to a deliberately unusable value first, then deleted, so the delete is
  // proven on a developer box too rather than being a line that only matters
  // where nobody looks. Nothing dials it: the Postgres backend connects lazily
  // and the first test asserts the file backend took the fixtures.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect';
  delete process.env.DATABASE_URL;

  previousOpenRead = process.env.PHILOTAS_OPEN_READ;
  delete process.env.PHILOTAS_OPEN_READ;

  process.chdir(tempDir);

  ({ sessionScope } = await import('../lib/corpus/scope.js'));
  ({ createUser, startSession } = await import('../lib/auth.js'));
  ({ upsertWorkspace, listWorkspaces, listUsers } = await import('../lib/db.js'));

  // First registered user is the admin, so register a throwaway one first and
  // make the analyst an ordinary operator at OFFICIAL — the shape that
  // actually runs in production.
  await createUser('scope-admin', 'not-a-real-password-1');
  analyst = await createUser('scope-analyst', 'not-a-real-password-2', { role: 'operator', clearance: 1 });
  analystToken = await startSession(analyst.id);

  ownCase = await upsertWorkspace({
    ownerId: analyst.id, name: 'Botany berth incident', data: {},
    visibility: 'private', classification: 1, sharedWith: [],
  });
  // Byte-identical to ownCase in every field the datastore records except the
  // owner. If this case had a different name, a different classification or a
  // different visibility, its absence from the analyst's scope could be blamed
  // on any of those instead of on ownership.
  strangerCase = await upsertWorkspace({
    ownerId: 'someone-else', name: 'Botany berth incident', data: {},
    visibility: 'private', classification: 1, sharedWith: [],
  });
  // Someone else's case, shared with this analyst by name. Scope has to include
  // it, or the boundary is owner-only and a team working one case together
  // would retrieve nothing from it.
  sharedWithAnalystCase = await upsertWorkspace({
    ownerId: 'someone-else', name: 'Kurnell jetty survey', data: {},
    visibility: 'private', classification: 1, sharedWith: ['scope-analyst'],
  });
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousOpenRead === undefined) delete process.env.PHILOTAS_OPEN_READ;
  else process.env.PHILOTAS_OPEN_READ = previousOpenRead;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// caseIds order follows the workspace lister's own sort, which is by last
// update and so by insertion time for fixtures written in the same
// millisecond. Membership is what scope means, so compare as sorted sets:
// deepEqual on both sides sorted is still exact about extras and omissions.
const asSet = (ids) => [...ids].sort();

test('the fixtures went to the throwaway datastore, not a real one', async () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'a surviving DATABASE_URL would put these fixtures in a live database');
  assert.equal(process.env.PHILOTAS_OPEN_READ, undefined, 'the refusal test below is meaningless with the read gate switched off');

  const scratchDatastore = path.join(tempDir, '.data', 'philotas-db.json');
  assert.ok(
    fs.existsSync(scratchDatastore),
    'the file backend must be the one that took the fixtures, and it must be rooted in the temp dir'
  );
  assert.match(fs.readFileSync(scratchDatastore, 'utf8'), /scope-analyst/);

  // Every account in the store is one this file created. A real datastore would
  // hold others, so this identifies the backend rather than counting rows —
  // later tests add accounts of their own and must not break this one.
  const created = new Set(['scope-admin', 'scope-analyst', 'scope-guest']);
  const users = await listUsers();
  for (const user of users) {
    assert.ok(created.has(user.username), `unexpected account ${user.username} — this is not a throwaway datastore`);
  }

  const realDatastore = path.join(originalCwd, '.data', 'philotas-db.json');
  if (fs.existsSync(realDatastore)) {
    assert.doesNotMatch(fs.readFileSync(realDatastore, 'utf8'), /scope-analyst/, 'no fixture reached the real datastore');
  }
});

test('scope comes from the session, and a case the session does not hold is absent', async () => {
  // The two cases differ by owner and by nothing else, asserted here so a later
  // edit to the fixtures cannot quietly turn the exclusion below into a
  // content difference.
  assert.equal(strangerCase.name, ownCase.name);
  assert.equal(strangerCase.visibility, ownCase.visibility);
  assert.equal(strangerCase.classification, ownCase.classification);
  assert.notEqual(strangerCase.ownerId, ownCase.ownerId);
  assert.notEqual(strangerCase.id, ownCase.id);

  // Non-vacuity: the stranger's case is a real row that the datastore hands
  // back to the session that holds it. Its absence below is therefore the
  // predicate working, not a fixture that was never retrievable.
  const asItsOwnOwner = await listWorkspaces({ id: 'someone-else', username: 'someone-else', clearance: 1 });
  assert.ok(asItsOwnOwner.some((w) => w.id === strangerCase.id), 'the bait must be retrievable, or this test proves nothing');

  const { caseIds, clearance, response } = await sessionScope(requestWithSession(analystToken));
  assert.equal(response, null, 'an authenticated session is not refused');
  assert.deepEqual(asSet(caseIds), asSet([ownCase.id, sharedWithAnalystCase.id]));
  assert.ok(!caseIds.includes(strangerCase.id), 'another owner\'s case is not in scope');
  assert.equal(clearance, 1, 'the ceiling is the session\'s clearance, not a request value');
});

test('a request parameter cannot widen the scope', async () => {
  // The attack: ask for someone else's case by name. The scope builder never
  // reads the URL, so the parameter is inert.
  const req = new Request(
    `http://localhost/api/corpus/search?q=x&caseIds=${strangerCase.id}&clearance=3`,
    { headers: { cookie: `philotas_session=${analystToken}` } }
  );
  const { caseIds, clearance } = await sessionScope(req);
  assert.deepEqual(asSet(caseIds), asSet([ownCase.id, sharedWithAnalystCase.id]), 'the requested case was ignored');
  assert.ok(!caseIds.includes(strangerCase.id), 'naming a case does not add it');
  assert.equal(clearance, 1, 'the requested clearance was ignored');
});

test('no session is refused, and carries no scope at all', async () => {
  const { response, caseIds, clearance, user } = await sessionScope(requestWithoutSession());
  assert.ok(response, 'the guard\'s refusal is returned to the caller');
  assert.equal(response.status, 401);
  assert.deepEqual(caseIds, []);
  assert.equal(clearance, 0, 'a refused caller carries no clearance either');
  assert.equal(user, null);
});

test('a session holding no cases gets an empty scope rather than an open one', async () => {
  // This is the trial guest: a real viewer session with no workspaces. Spec
  // section 8 — it retrieves nothing from the case corpus.
  const guest = await createUser('scope-guest', 'not-a-real-password-3', { role: 'viewer', clearance: 0 });
  const token = await startSession(guest.id);

  // Non-vacuity again: the datastore is not empty, so an empty scope here is
  // the guest holding nothing rather than there being nothing to hold.
  const analystScope = await sessionScope(requestWithSession(analystToken));
  assert.ok(analystScope.caseIds.length > 0, 'the store holds cases, they are just not this guest\'s');

  const { caseIds, clearance, response } = await sessionScope(requestWithSession(token));
  assert.equal(response, null, 'a viewer is a valid session');
  assert.deepEqual(caseIds, [], 'no cases means no scope, not every case');
  assert.equal(clearance, 0);
});

test('with the read gate open, a caller with no session still holds no cases', async () => {
  // The bait is created here rather than in before(), because a case an
  // anonymous caller can see is by construction one the analyst can see too,
  // and the scope assertions above are exact. node:test runs the top-level
  // tests in this file sequentially, so it does not exist while they run; were
  // that ever to change they would fail loudly rather than pass for a new
  // reason.
  const unclassifiedAndShared = await upsertWorkspace({
    ownerId: 'someone-else', name: 'Harbour traffic, open', data: {},
    visibility: 'shared', classification: 0, sharedWith: [],
  });
  const withoutAnyUser = await listWorkspaces(null);
  assert.ok(
    withoutAnyUser.some((w) => w.id === unclassifiedAndShared.id),
    'the bait must be visible to a userless workspace lookup, or this test proves nothing'
  );

  process.env.PHILOTAS_OPEN_READ = '1';
  try {
    const { user, caseIds, clearance, response } = await sessionScope(requestWithoutSession());
    assert.equal(response, null, 'the escape hatch is what it is for — the viewer-level read is let through');
    assert.equal(user, null, 'and it is let through with no user');
    assert.deepEqual(caseIds, [], 'no user means no cases, not every unclassified shared case');
    assert.equal(clearance, 0, 'and the lowest possible ceiling');
  } finally {
    delete process.env.PHILOTAS_OPEN_READ;
  }
});
