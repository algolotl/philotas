// test/db-retry.test.js
//
// pgBackend's init() memoises its promise, and until 2026-08-17 it memoised the
// REJECTED one too, so one refused connect left every user, session, workspace,
// vessel and event read failing for the life of the process. That was survivable
// while init() first ran on a request. It stopped being survivable when
// lib/schema/startup.js started calling semanticPool() at boot: an app that
// starts a second before its database would never recover without a restart.
//
// The fix landed with nothing pinning it. test/schema-startup-pg.test.js aims at
// this and can only observe repeated FAILURES — it dials a closed port and
// compares error identities — and lib/db.js's own comment records that the
// over-correction which clears `ready` after SUCCESS too, rebuilding a pg.Pool
// per query, left that suite entirely green. Both halves need init() to be able
// to SUCCEED without a database, and that is what this file adds.
//
// THE SEAM IS A LOADER STUB FOR `pg`, resolved by a node:module hook to an
// in-repo data URL. It adds no dependency and it is the only thing in the import
// graph that could open a socket, so nothing here can reach a database even by
// accident — asserted below rather than claimed, by checking the stub is what
// took every pool construction.
//
// lib/db.js chooses its backend from process.env.DATABASE_URL at import time and
// hands the value straight to the pool as `connectionString`. Reaching pgBackend
// at all therefore requires that variable to be set, and it is set here to a
// string that is NOT a connection string and names no host, port, database or
// credential. The stub ignores it, and the tests assert the pool received exactly
// that literal, which is the proof no real DSN was ever in play. It is removed
// again in after().
//
// THE FAILURE IS INJECTED BEFORE THE FIRST IMPORTED CALL, in before(), and that
// ordering is load-bearing rather than tidy. `ready` memoises whichever outcome
// settles FIRST, so a successful call anywhere ahead of the failing one settles
// init() and the later failure becomes an ordinary query rejection that never
// touches the memoisation at all. Written the other way round this file passed
// against the bug it exists to catch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Deliberately unparseable as a DSN: no scheme, no host, no port, no password.
const NOT_A_CONNECTION_STRING = 'parallax-pg-loader-stub-only-never-dialled';
const REFUSED = 'connect ECONNREFUSED 127.0.0.1:1';
const STUB_USER_COUNT = 7;

// The stub stands in for the `pg` package's default export. It mirrors the two
// members lib/db.js uses and the shape of the failure it has to survive: pg's
// `new Pool()` does not connect — it is `pool.query()` that rejects with
// ECONNREFUSED, measured at 7 ms against a closed port on 2026-08-17 — so the
// constructor always succeeds here and the failure is injected into the query.
const pgStubSource = `
  export default {
    Pool: class Pool {
      constructor(config) {
        const stub = globalThis.__parallaxPgStub;
        stub.constructed.push(config);
        this.poolId = stub.constructed.length;
      }
      async query(text, params) {
        const stub = globalThis.__parallaxPgStub;
        stub.queries.push({ poolId: this.poolId, text, params });
        if (stub.connectFailure) {
          throw Object.assign(new Error(stub.connectFailure), { code: 'ECONNREFUSED', port: 1 });
        }
        return { rows: [{ n: String(stub.userCount) }], rowCount: 1 };
      }
      async end() {}
    },
  };
`;
const pgStubUrl = `data:text/javascript,${encodeURIComponent(pgStubSource)}`;

const loaderSource = `
  const pgStubUrl = ${JSON.stringify(pgStubUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'pg') return { url: pgStubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);

const isBaseDdl = (query) => /CREATE TABLE IF NOT EXISTS users/.test(query.text);

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let stub;
let countUsers;
let semanticPool;

before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-db-retry-'));
  previousDatabaseUrl = process.env.DATABASE_URL;

  // Armed from the outset. See the header: the very first init() in this process
  // has to be the one that fails, or the memoisation is never exercised.
  stub = { constructed: [], queries: [], connectFailure: REFUSED, userCount: STUB_USER_COUNT };
  globalThis.__parallaxPgStub = stub;

  // Overwritten, never read: whatever this box has configured is irrelevant and
  // must not reach the import below, which is the only moment lib/db.js looks at
  // it. Overwriting rather than reading is also what makes the literal assertion
  // in the first test meaningful.
  process.env.DATABASE_URL = NOT_A_CONNECTION_STRING;
  process.chdir(tempDir);

  ({ countUsers, semanticPool } = await import('../lib/db.js'));
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  delete globalThis.__parallaxPgStub;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------- the pin
//
// The property: A FIRST CALL THAT REJECTS MUST NOT PREVENT A LATER CALL FROM
// SUCCEEDING. Deleting the `attempt.catch(...)` line in lib/db.js that clears
// `ready` makes the second countUsers() below replay the first call's rejected
// promise, and this is the only test in the suite that fails.
//
// Registered first on purpose, and the assertion on `constructed.length` is what
// enforces that: node:test runs top-level tests in a file in registration order,
// so a reorder that let a success settle init() ahead of this would fail here
// rather than pass vacuously.
test('a connection that fails once does not poison the datastore for the process', async () => {
  const failure = await countUsers().then(() => null, (err) => err);

  // Non-vacuity, and the wiring check at the same time: the first call really did
  // fail, it failed inside init() where the memoisation lives, and the thing that
  // failed was the stub rather than anything holding a socket.
  assert.ok(failure, 'the first call must reject, or there is nothing to recover from');
  assert.equal(failure.code, 'ECONNREFUSED');
  assert.equal(failure.message, REFUSED, 'the rejection is the injected one, not an incidental error');
  assert.equal(stub.constructed.length, 1, 'exactly one pool was built, and the stub is what built it');
  assert.equal(
    stub.constructed[0].connectionString,
    NOT_A_CONNECTION_STRING,
    'the pool was handed the inert literal, so nothing real was ever addressable'
  );
  assert.ok(isBaseDdl(stub.queries[0]), 'the failure happened on init()’s own DDL, inside the memoised promise');

  // The database comes up. Nothing else changes.
  stub.connectFailure = null;

  const recovered = await countUsers();
  assert.equal(recovered, STUB_USER_COUNT, 'the later call succeeded rather than replaying a cached rejection');

  // How the retry is observed structurally rather than only by the absence of a
  // throw: a fresh attempt has to construct a new pool, because the rejected one
  // never finished its DDL. A memoised rejection constructs nothing.
  assert.equal(stub.constructed.length, 2, 'the recovery re-entered init() and built a fresh pool');
  assert.equal(
    stub.queries.at(-1).poolId,
    2,
    'the successful query went to the new pool, not to the one whose connect was refused'
  );
});

test('a connection that succeeded is reused, not rebuilt on every call', async () => {
  // The other half of the same two lines, and the reason they must not be
  // "simplified" into `attempt.catch(() => {}).then(() => { ready = null; })`.
  // That variant clears `ready` after SUCCESS too, so every call builds a new
  // pg.Pool, opens a new connection and re-runs the whole base DDL — a connection
  // storm that looks like working code. lib/db.js recorded on 2026-08-17 that the
  // mutation left the suite green because no test could let init() succeed without
  // a database. This one can.
  stub.connectFailure = null;

  // Settle init() from inside this test rather than relying on the one above, so
  // this test is not order-coupled to it.
  await countUsers();
  const constructedBefore = stub.constructed.length;
  const ddlBefore = stub.queries.filter(isBaseDdl).length;
  assert.ok(constructedBefore > 0, 'a pool exists to be reused');

  // Several calls across two different exports, since semanticPool() hands out
  // the same pool the row accessors use — the "one connection pool per process"
  // promise in lib/db.js, which nothing pinned either.
  const counts = [await countUsers(), await countUsers(), await countUsers()];
  const poolA = await semanticPool();
  const poolB = await semanticPool();

  assert.deepEqual(
    counts,
    [STUB_USER_COUNT, STUB_USER_COUNT, STUB_USER_COUNT],
    'every call answered, so this is not a pin over a broken path'
  );
  assert.equal(stub.constructed.length, constructedBefore, 'a settled connection must not be rebuilt per call');
  assert.equal(
    stub.queries.filter(isBaseDdl).length,
    ddlBefore,
    'and the base DDL must not be re-run per call'
  );
  assert.strictEqual(poolA, poolB, 'the semantic layer gets the one pool, twice');
  assert.equal(poolA.poolId, constructedBefore, 'and it is the same pool the row accessors just used');
});

test('every pool in this process came from the loader stub, so no database was touched', async () => {
  // Cumulative and order-independent: whatever the tests above did, the only
  // `pg` implementation in the graph was the stub and the only connection string
  // in play was the inert literal.
  assert.equal(process.env.DATABASE_URL, NOT_A_CONNECTION_STRING);
  assert.ok(stub.constructed.length > 0, 'pools were built, so this is not an empty claim');
  for (const config of stub.constructed) {
    assert.equal(config.connectionString, NOT_A_CONNECTION_STRING);
  }
  assert.ok(stub.queries.length > 0, 'and every query went to the stub');
});
