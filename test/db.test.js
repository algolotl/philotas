import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// THE MOST IMPORTANT TEST FILE IN THE REPO.
//
// lib/db.js's fileBackend().listWorkspaces(user) is the clearance gate: it
// decides whether a workspace classified above a user's clearance is ever
// returned from the datastore. Everything downstream (the workspaces API
// route, the UI) trusts this function completely — there is no second gate.
//
// lib/db.js picks its backend and resolves the file path from
// process.cwd() the moment it is imported (DATABASE_URL unset -> fileBackend,
// DIR = path.join(process.cwd(), '.data')). To avoid writing into the
// developer's real .data/philotas-db.json, we chdir into a throwaway
// directory *before* the dynamic import below runs — a static top-level
// import would be hoisted ahead of the chdir and defeat this. Each test file
// under `node --test` runs in its own child process (confirmed empirically:
// a chdir in one test file's process is invisible to another), so this is
// isolated from every other test file and from the real working directory.
//
// The chdir is only half of it, and the other half was missing. `DATABASE_URL
// unset` above is an assumption about the machine, not something this file
// established: on a host that has it set — the trial, where this branch's own
// workflow ran the suite — lib/db.js picks the Postgres backend at import time
// and no amount of chdir changes that. The fixtures below would then be three
// real workspaces, two of them classified SECRET, inserted into the live
// database. So DATABASE_URL is removed here and the file backend is asserted,
// the same way test/frames.test.js and test/poller-reaping.test.js do it.

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let listWorkspaces;
let upsertWorkspace;

// Clearance levels, per lib/auth.js CLASSES: 0 UNCLASSIFIED, 1 OFFICIAL,
// 2 SECRET, 3 TOP SECRET.
const OWNER = { id: 'owner-1', username: 'owner' };

let secretShared;          // classification 2, visibility 'shared'
let secretPrivateNamed;    // classification 2, visibility 'private', sharedWith: ['analyst']
let unclassPrivateNamed;   // classification 0, visibility 'private', sharedWith: ['analyst']

// A single before() hook, deliberately not split in two: node:test runs
// multiple top-level before() hooks in the same file CONCURRENTLY, not in
// registration order (confirmed empirically — a second hook reading a
// variable the first hook sets saw it as undefined). Splitting "chdir + import"
// from "seed fixtures" into separate hooks races the import against the seed.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-db-test-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  // Set to a deliberately unusable value first, then deleted, so the delete is
  // proven on a developer box too rather than being a line that only matters
  // where nobody looks. Nothing dials it — lib/db.js's pgBackend connects
  // lazily and the assertion below fires first.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect';
  delete process.env.DATABASE_URL;

  process.chdir(tempDir);
  ({ listWorkspaces, upsertWorkspace } = await import('../lib/db.js'));

  secretShared = await upsertWorkspace({
    ownerId: OWNER.id, name: 'Secret Shared Ops', data: {},
    visibility: 'shared', classification: 2, sharedWith: [],
  });
  secretPrivateNamed = await upsertWorkspace({
    ownerId: OWNER.id, name: 'Secret Private, named analyst', data: {},
    visibility: 'private', classification: 2, sharedWith: ['analyst'],
  });
  unclassPrivateNamed = await upsertWorkspace({
    ownerId: OWNER.id, name: 'Unclassified Private, named analyst', data: {},
    visibility: 'private', classification: 0, sharedWith: ['analyst'],
  });
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const sees = (list, ws) => list.some((w) => w.id === ws.id);

test('the fixtures were written to the throwaway datastore, not to a real one', () => {
  // lib/db.js exports no backend name, so the backend is identified by where
  // the three fixtures above landed. A surviving DATABASE_URL means no file
  // here and three classified workspaces in a live database instead; a lost
  // chdir means they are in the developer's own .data/philotas-db.json.
  const scratchDatastore = path.join(tempDir, '.data', 'philotas-db.json');
  assert.ok(
    fs.existsSync(scratchDatastore),
    'the file backend must be the one that took the fixtures, and it must be rooted in the temp dir'
  );
  assert.match(fs.readFileSync(scratchDatastore, 'utf8'), /Secret Shared Ops/);

  // And the developer's own datastore, which does exist on a box that has ever
  // run the app, is untouched by name.
  const realDatastore = path.join(originalCwd, '.data', 'philotas-db.json');
  if (fs.existsSync(realDatastore)) {
    assert.doesNotMatch(fs.readFileSync(realDatastore, 'utf8'), /Secret Shared Ops/, 'no fixture reached the real datastore');
  }
});

test('a SECRET-classified workspace is NOT returned to a clearance-1 (OFFICIAL) user', async () => {
  const official = { id: 'u-official', username: 'official', clearance: 1 };
  const result = await listWorkspaces(official);
  assert.ok(!sees(result, secretShared), 'clearance 1 must not see a classification-2 workspace');
});

test('a SECRET-classified workspace IS returned to clearance 2 and clearance 3 users', async () => {
  const secretUser = { id: 'u-secret', username: 'secret-user', clearance: 2 };
  const topSecretUser = { id: 'u-topsecret', username: 'topsecret-user', clearance: 3 };
  assert.ok(sees(await listWorkspaces(secretUser), secretShared), 'clearance 2 should meet classification 2');
  assert.ok(sees(await listWorkspaces(topSecretUser), secretShared), 'clearance 3 should meet classification 2');
});

test('an owner always sees their own workspace regardless of classification', async () => {
  // Deliberately give the owner a clearance BELOW the workspace's own
  // classification. The ownerId check in lib/db.js runs before the
  // classification check and short-circuits it, so this must still be
  // visible — an owner is never locked out of their own workspace.
  const ownerButUnderCleared = { id: OWNER.id, username: OWNER.username, clearance: 0 };
  const result = await listWorkspaces(ownerButUnderCleared);
  assert.ok(sees(result, secretShared), 'owner must see their own SECRET workspace even at clearance 0');
});

test('a shared workspace is visible to anyone adequately cleared, not just the owner', async () => {
  const secretUser = { id: 'u-secret-2', username: 'someone-else', clearance: 2 };
  const result = await listWorkspaces(secretUser);
  assert.ok(sees(result, secretShared), 'visibility "shared" means any sufficiently cleared user, no sharedWith entry needed');
});

test('a private workspace is visible to a user named in sharedWith', async () => {
  const analyst = { id: 'u-analyst', username: 'analyst', clearance: 1 };
  const result = await listWorkspaces(analyst);
  assert.ok(sees(result, unclassPrivateNamed), 'named + adequately cleared must see the private workspace');
});

test('a private workspace is NOT visible to someone who is neither owner nor named in sharedWith', async () => {
  const outsider = { id: 'u-outsider', username: 'outsider', clearance: 3 };
  const result = await listWorkspaces(outsider);
  assert.ok(!sees(result, unclassPrivateNamed), 'high clearance alone must not substitute for owner/sharedWith on a private workspace');
});

test('classification still gates a private workspace even for a user named in sharedWith', async () => {
  // Non-obvious precedence in lib/db.js's `vis` closure: the classification
  // check runs BEFORE the sharedWith check. So being named in sharedWith on a
  // SECRET-classified private workspace does not help a clearance-1 user —
  // clearance is the outer gate and sharedWith only narrows within it, it
  // never widens past it.
  const underClearedAnalyst = { id: 'u-analyst-lo', username: 'analyst', clearance: 1 };
  const result = await listWorkspaces(underClearedAnalyst);
  assert.ok(!sees(result, secretPrivateNamed), 'being named in sharedWith must not override the classification gate');
});

test('an anonymous caller (no user) sees nothing that is not both unclassified and shared', async () => {
  const result = await listWorkspaces(null);
  assert.ok(!sees(result, secretShared));
  assert.ok(!sees(result, secretPrivateNamed));
  assert.ok(!sees(result, unclassPrivateNamed), 'private workspaces require a username to match sharedWith, and there is no user to match');
});
