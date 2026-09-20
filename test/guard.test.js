import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// lib/db.js resolves its file-backend path from process.cwd() at the moment
// it is first imported (DIR = path.join(process.cwd(), '.data')). We chdir
// into a scratch directory *before* dynamically importing anything that
// pulls db.js in, so a real login flow here writes to a throwaway
// .data/philotas-db.json instead of the developer's real one. Each test file
// under `node --test` runs in its own child process, so this chdir cannot
// leak into any other test file — verified empirically before writing this.
//
// The chdir only decides where the FILE backend writes. Which backend gets
// picked is decided by DATABASE_URL at import time, so on a host that has one
// set — the trial, where this branch's own workflow ran the suite — these
// tests would create real accounts in the live database, including
// `guard-admin` at role admin with the password written in plain sight below.
// So DATABASE_URL is removed here too, and 'the accounts went to the throwaway
// datastore' asserts that it worked.
let originalCwd;
let tempDir;
let previousDatabaseUrl;
let requireUser;
let createUser;
let startSession;

before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-guard-test-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  // Set to a deliberately unusable value first, then deleted, so the delete is
  // proven on a developer box too. Nothing dials it: lib/db.js's pgBackend
  // connects lazily and the assertion in the final test fires long before any
  // query would.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect';
  delete process.env.DATABASE_URL;

  process.chdir(tempDir);
  ({ requireUser } = await import('../lib/guard.js'));
  ({ createUser, startSession } = await import('../lib/auth.js'));
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function requestWithCookie(token) {
  const headers = token ? { cookie: `philotas_session=${token}` } : {};
  return new Request('http://localhost/api/test', { headers });
}

// ---------------------------------------------------------------- PHILOTAS_OPEN_READ
// This is the escape hatch's whole reason for existing: it must widen exactly
// one thing (unauthenticated viewer-level reads on a closed network) and
// nothing else. If it ever leaked into operator/admin, an unauthenticated
// caller could reach write or admin routes on a network that was only ever
// supposed to expose read-only data without a login prompt.

test('no session, flag unset: viewer read is unauthorised', async () => {
  delete process.env.PHILOTAS_OPEN_READ;
  const { user, response } = await requireUser(requestWithCookie(null), 'viewer');
  assert.equal(user, null);
  assert.ok(response, 'expected a denial response');
  assert.equal(response.status, 401);
});

test('no session, flag=1: viewer read is let through', async () => {
  process.env.PHILOTAS_OPEN_READ = '1';
  const { user, response } = await requireUser(requestWithCookie(null), 'viewer');
  assert.equal(user, null);
  assert.equal(response, null, 'the escape hatch should return no response at viewer level');
  delete process.env.PHILOTAS_OPEN_READ;
});

test('no session, flag=1: operator route is still unauthorised', async () => {
  process.env.PHILOTAS_OPEN_READ = '1';
  const { user, response } = await requireUser(requestWithCookie(null), 'operator');
  assert.equal(user, null);
  assert.ok(response, 'the escape hatch must not apply above viewer');
  assert.equal(response.status, 401);
  delete process.env.PHILOTAS_OPEN_READ;
});

test('no session, flag=1: admin route is still unauthorised', async () => {
  process.env.PHILOTAS_OPEN_READ = '1';
  const { user, response } = await requireUser(requestWithCookie(null), 'admin');
  assert.ok(response);
  assert.equal(response.status, 401);
  delete process.env.PHILOTAS_OPEN_READ;
});

test('flag is only recognised at the exact string "1"', async () => {
  // openRead() checks `=== '1'`. Truthy-but-not-'1' values (a stray "true",
  // or a leftover "0") must not enable the hatch.
  process.env.PHILOTAS_OPEN_READ = 'true';
  const { response } = await requireUser(requestWithCookie(null), 'viewer');
  assert.ok(response, '"true" must not be treated as enabling the escape hatch');
  assert.equal(response.status, 401);
  delete process.env.PHILOTAS_OPEN_READ;
});

// ---------------------------------------------------------------- role gating
// Complements test/auth.test.js's pure atLeast() table by proving requireUser
// actually wires a real session's role through it end to end.

test('a signed-in viewer is let through at viewer level', async () => {
  const { id } = await createUser('guard-viewer', 'password123', { role: 'viewer', clearance: 0 });
  const token = await startSession(id);
  const { user, response } = await requireUser(requestWithCookie(token), 'viewer');
  assert.equal(response, null);
  assert.equal(user.username, 'guard-viewer');
});

test('a signed-in viewer is forbidden at operator level', async () => {
  const { id } = await createUser('guard-viewer-2', 'password123', { role: 'viewer', clearance: 0 });
  const token = await startSession(id);
  const { user, response } = await requireUser(requestWithCookie(token), 'operator');
  assert.ok(user, 'requireUser still returns the identified user alongside the denial');
  assert.ok(response);
  assert.equal(response.status, 403);
});

test('a signed-in admin passes every level', async () => {
  const { id } = await createUser('guard-admin', 'password123', { role: 'admin', clearance: 3 });
  const token = await startSession(id);
  for (const level of ['viewer', 'operator', 'admin']) {
    const { response } = await requireUser(requestWithCookie(token), level);
    assert.equal(response, null, `admin should pass at ${level}`);
  }
});

test('the accounts went to the throwaway datastore, not to a real one', () => {
  // lib/db.js exports no backend name, so the backend is identified by where
  // the accounts above landed. A surviving DATABASE_URL means no file here and
  // a real `guard-admin` in a live database; a lost chdir means the accounts
  // are in the developer's own .data/philotas-db.json.
  const scratchDatastore = path.join(tempDir, '.data', 'philotas-db.json');
  assert.ok(fs.existsSync(scratchDatastore), 'the file backend must be the one that took the accounts');
  assert.match(fs.readFileSync(scratchDatastore, 'utf8'), /guard-admin/);

  const realDatastore = path.join(originalCwd, '.data', 'philotas-db.json');
  if (fs.existsSync(realDatastore)) {
    assert.doesNotMatch(fs.readFileSync(realDatastore, 'utf8'), /guard-admin/, 'no test account reached the real datastore');
  }
});

// An absent clearance must read as UNCLASSIFIED, not OFFICIAL.
//
// currentUser() defaulted this to 1 while the other eight readers in the
// codebase default to 0. It was the only one that failed open, and it sits on
// the read path, so a record with no clearance would have been handed OFFICIAL
// by the session and UNCLASSIFIED by everything reading the raw row.
//
// The record is written directly rather than through createUser, because
// createUser always sets the field — the case under test is a row that came from
// somewhere else, which under per-client deployment means an onboarding script.
test('a session for a user with no clearance reads as UNCLASSIFIED', async () => {
  const { currentUser } = await import('../lib/auth.js');
  const db = await import('../lib/db.js');

  const { id } = await createUser('no-clearance-probe', 'password123', { role: 'operator', clearance: 2 });
  const token = await startSession(id);

  // Strip the field, the way a row written outside createUser would arrive.
  await db.setUserRole(id, 'operator', undefined);

  const user = await currentUser(new Request('http://localhost/', {
    headers: { cookie: `philotas_session=${token}` },
  }));

  assert.ok(user, 'the session should still resolve; only the clearance default is under test');
  assert.equal(user.clearance, 0,
    'an absent clearance read as OFFICIAL, which is the one default in this codebase ' +
    'that failed open — every other reader treats absent as UNCLASSIFIED');
  // Breaks when: currentUser goes back to `?? 1`, or to any non-zero fallback.
});
