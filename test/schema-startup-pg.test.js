// test/schema-startup-pg.test.js
//
// The Postgres branch of semanticPool(), which is the branch the trial runs and
// the one test/schema-startup.test.js structurally cannot reach: lib/db.js
// chooses its backend once, from DATABASE_URL, at import time, so the two
// branches need two processes and `node --test` gives one process per file.
//
// NO REAL DATABASE IS INVOLVED, and this file does not need one. DATABASE_URL is
// pointed at 127.0.0.1 port 1 — a port nothing can be listening on, the same
// unusable string test/db.test.js and test/guard.test.js write down and then
// delete. Here it is deliberately left in place instead of deleted, because
// "Postgres is configured but unreachable" IS the case under test: it is what a
// deploy looks like in the seconds before the database accepts connections, and
// getting it wrong takes the whole server down at boot.
//
// Measured on 2026-08-17, `node --input-type=module -e` against this string:
// pg.Pool.query rejects with ECONNREFUSED after 7 ms, the pool raises no
// unhandled 'error' event, and pool.end() resolves. So this costs milliseconds
// and cannot hang.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UNREACHABLE = 'postgres://unused:unused@127.0.0.1:1/parallax-must-not-connect';

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let ensureSemanticSchema;
let semanticPool;

before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-schema-startup-pg-'));
  previousDatabaseUrl = process.env.DATABASE_URL;
  // Overwritten, not read: whatever this box has configured is irrelevant and
  // must not be dialled. The overwrite happens before the import below, which
  // is the only moment lib/db.js reads it.
  process.env.DATABASE_URL = UNREACHABLE;
  process.chdir(tempDir);
  ({ ensureSemanticSchema } = await import('../lib/schema/startup.js'));
  ({ semanticPool } = await import('../lib/db.js'));
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the Postgres backend was selected, and it is aimed at a port nothing can answer', async () => {
  assert.ok(
    process.env.DATABASE_URL === UNREACHABLE,
    'this test process must be pointed at the unusable string, never at an inherited real one'
  );
  const err = await semanticPool().then(() => null, (e) => e);
  // The file backend answers null here. A rejection is therefore proof that the
  // Postgres backend is the one that took the call — and the port proves which
  // host it tried.
  assert.ok(err, 'the Postgres backend tried to connect rather than answering null');
  assert.equal(err.code, 'ECONNREFUSED');
  assert.equal(err.port, 1, 'it dialled the closed port, so no real database was touched');
});

test('an unreachable Postgres at boot is a named degradation, not a thrown boot', async () => {
  // The whole reason lib/schema/startup.js exists in front of
  // applySemanticSchema: a rejection here, left alone, propagates out of
  // register() as an unhandled rejection in the Next.js instrumentation hook,
  // which either kills the server or vanishes depending on where it lands. Both
  // are worse than the map and the feeds coming up without retrieval.
  const result = await ensureSemanticSchema();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'pool-failed');
  assert.match(result.detail, /ECONNREFUSED/);
});

test('a failed connection at boot does not poison the datastore for the whole process', async () => {
  // pgBackend's init() memoises its promise, and until 2026-08-17 it memoised
  // the REJECTED one too. Measured that day with
  // `DATABASE_URL=<unreachable> node -e "countUsers(); countUsers()"`: both
  // calls came back with the IDENTICAL error object, meaning one refused
  // connect left every user, session, workspace, vessel and event read failing
  // for the life of the process. That was survivable while init() first ran on
  // a request; it is not survivable now that boot calls semanticPool(), because
  // an app that starts a second before its database would never recover without
  // a restart.
  //
  // Distinct error objects are how the retry is observed: a memoised rejection
  // hands back the same instance every time, a fresh attempt cannot.
  const first = await semanticPool().then(() => null, (e) => e);
  const second = await semanticPool().then(() => null, (e) => e);
  assert.equal(first.code, 'ECONNREFUSED');
  assert.equal(second.code, 'ECONNREFUSED');
  assert.notStrictEqual(first, second, 'the second call re-attempted rather than replaying a cached rejection');
});
