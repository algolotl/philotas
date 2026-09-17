// test/schema-startup.test.js
//
// The semantic schema has existed since increment 2 and nothing has ever
// applied it, so a fresh deployment has no documents, chunks or
// entity_profiles table at all — `grep -rn applySemanticSchema app lib` on
// 2026-08-17 returned its own definition and two test files, nothing else.
// This file covers the wiring that fixes that, and the four ways it can go
// wrong: no pool, a pool that cannot be reached, a pool that rejects the DDL,
// and a startup hook that runs in the wrong runtime.
//
// lib/schema/startup.js imports lib/db.js, which picks its backend and
// resolves the file-backend path from process.cwd() the moment it is
// imported. So DATABASE_URL is removed and the cwd is a throwaway directory
// BEFORE the dynamic import below — a static import would hoist above both.
// The Postgres branch of semanticPool() cannot be reached from this process at
// all once the backend is chosen; test/schema-startup-pg.test.js is a separate
// file for exactly that reason.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let previousNextRuntime;
let ensureSemanticSchema;
let lastStartupResult;
let _resetStartupResult;
let semanticPool;

before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallax-schema-startup-'));
  previousDatabaseUrl = process.env.DATABASE_URL;
  previousNextRuntime = process.env.NEXT_RUNTIME;
  // Set to a deliberately unusable value first, then deleted, so the delete is
  // proven on a developer box too rather than being a line that only matters
  // where nobody looks. Nothing dials it: pgBackend connects lazily.
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/parallax-must-not-connect';
  delete process.env.DATABASE_URL;
  process.chdir(tempDir);
  ({ ensureSemanticSchema, lastStartupResult, _resetStartupResult } = await import('../lib/schema/startup.js'));
  ({ semanticPool } = await import('../lib/db.js'));
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = previousNextRuntime;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the file backend was selected, so nothing here can reach a real database', async () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL is unset for this process');
  assert.equal(await semanticPool(), null, 'the file backend offers no semantic pool');
});

test('with no pool it declines by name rather than throwing or passing silently', async () => {
  const result = await ensureSemanticSchema();
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no-pool');
});

test('given a pool it delegates to the applier with that exact pool and returns its answer', async () => {
  // The applier is stubbed, so this pins the wiring — which pool the DDL is
  // aimed at and whose answer is returned — not the DDL itself. The DDL is
  // test/schema-apply.test.js's job. 'it actually applies the schema' would be
  // a claim this assertion cannot support.
  const seen = [];
  const pool = { id: 'stub-pool' };
  const apply = async (p) => { seen.push(p); return { applied: true, marker: 'from-the-applier' }; };
  const result = await ensureSemanticSchema({ pool, apply });
  assert.equal(result.applied, true);
  assert.equal(result.marker, 'from-the-applier', 'the applier’s own result is returned, not a rebuilt one');
  assert.deepEqual(seen, [pool], 'the schema was applied against the pool it was given');
});

test('the default applier is the real applySemanticSchema, not a stub left behind', async () => {
  // Passing no `apply` has to reach lib/schema/apply.js. With DATABASE_URL
  // unset that function short-circuits to 'no-database' before it touches the
  // pool, which is what makes this assertion possible without a database at
  // all. The pool below has no .query method on purpose: anything that got
  // past the env check and tried to use it would come back 'schema-failed'
  // instead, so this distinguishes the real applier from a stubbed one.
  const result = await ensureSemanticSchema({ pool: { id: 'stub-pool' } });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no-database', 'lib/schema/apply.js decided this, nothing here');
});

test('a rejected DDL is a named failure, not an exception that kills the boot', async () => {
  const apply = async () => { throw new Error('permission denied for schema public'); };
  const result = await ensureSemanticSchema({ pool: { id: 'stub-pool' }, apply });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'schema-failed');
  assert.match(result.detail, /permission denied/);
});

test('a pool that cannot be obtained is named separately from a DDL that was refused', async () => {
  // The distinction is the whole point of having two names: 'pool-failed' is
  // "Postgres was not reachable at boot" and an operator waits or fixes the
  // network, 'schema-failed' is "Postgres answered and said no" and an
  // operator fixes a grant. Measured on 2026-08-17 with
  // `DATABASE_URL=postgres://...@127.0.0.1:1/... node -e "await countUsers()"`:
  // pgBackend's init() rejects with ECONNREFUSED, and in the brief's original
  // shape that rejection was raised outside the try block — so it escaped
  // ensureSemanticSchema, escaped register(), and became an unhandled
  // rejection in the Next.js instrumentation hook. This is that path.
  const pool = Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:1'));
  const result = await ensureSemanticSchema({ pool });
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'pool-failed');
  assert.match(result.detail, /ECONNREFUSED/);
});

// NEXT_RUNTIME is set AND restored per test rather than once for the file. The
// three cases below want three different states of the same variable, one of them
// "absent", so a value left behind by whichever test ran first would silently
// decide the others — insert a test between them and the outcome changes. Same
// order-coupling class as the lastResult carry-over that made the brief's stated
// kill mechanism wrong.
async function registerWithRuntime(t, runtime) {
  const previous = process.env.NEXT_RUNTIME;
  t.after(() => {
    if (previous === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = previous;
  });
  if (runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = runtime;
  _resetStartupResult();
  const { register } = await import('../instrumentation.js');
  await register();
}

test('the startup hook runs the schema step and leaves a readable result behind', async (t) => {
  await registerWithRuntime(t, 'nodejs');
  const result = lastStartupResult();
  assert.ok(result, 'register() recorded a startup result');
  assert.equal(result.reason, 'no-pool', 'on the file backend the hook declines by name');
});

test('with NEXT_RUNTIME absent the schema step still runs, because failing closed there is worse', async (t) => {
  // The case that decides whether a fresh install provisions itself. Next sets
  // NEXT_RUNTIME on its own server, but this hook can be imported by a process
  // that does not: a container entrypoint, a warm-up script, a future worker. A
  // guard written as `=== 'nodejs'` skips every one of those, and the symptom is a
  // deployment that comes up with no documents, chunks or entity_profiles table,
  // no error, and a log line saying it decided not to bother. Absent means run.
  await registerWithRuntime(t, undefined);
  assert.equal(process.env.NEXT_RUNTIME, undefined, 'the variable really is absent for this call');
  const result = lastStartupResult();
  assert.ok(result, 'the schema step ran rather than being skipped');
  assert.equal(result.reason, 'no-pool', 'and it reached the file backend, which declines by name');
});

test('the startup hook does nothing at all in the edge runtime', async (t) => {
  // Edge is the one runtime that provably cannot do this work: no net, no tls and
  // no dns, so no Postgres driver, and importing pg there is a build failure
  // rather than a degraded read. Measured 2026-08-17: an edge build of this hook
  // exists in .next/server/edge/ on the current tree, so the exclusion is live
  // rather than precautionary. A null result afterwards is how we know the guard
  // fired, rather than the schema step having run and declined for its own
  // separate reasons.
  await registerWithRuntime(t, 'edge');
  assert.equal(lastStartupResult(), null, 'the edge runtime never reached the schema step');
});
