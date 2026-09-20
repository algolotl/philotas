// test/register-error-disclosure.test.js
//
// POST /api/auth/register is FULLY UNAUTHENTICATED — it is the door a new
// account comes through, so there is no session to gate it with. It also wrote
// `String(err.message || err)` onto its 400, and everything createUser touches
// goes through lib/db.js. On a deployment with DATABASE_URL set, a datastore
// that is refusing connections makes Node throw `connect ECONNREFUSED
// <host>:<port>` — the host and port of DATABASE_URL — and that string went out
// to anyone on the internet who posted a username. A refused INSERT names a
// constraint instead, which is the schema.
//
// THE DISTINCTION THIS FILE PINS. Registration has to be able to say WHY it
// refused: "username already taken" is not a leak, it is the answer, and a route
// that returns a generic error instead is unusable. So the property is not
// "no message" — it is:
//
//   the errors createUser raises DELIBERATELY are disclosable;
//   the ones that ESCAPE it from the datastore are not.
//
// Before this task those two were the same shape (a bare `new Error`), which is
// the actual defect. lib/errors.js gives the deliberate ones a brand and the
// route reads it.
//
// AND THE STATUS. A database that is down is not the caller's bad request, so
// the escaped case is a 503 rather than a 400 — a monitor watching the trial can
// tell "someone picked a taken name" from "our datastore is gone".
//
// WHAT IS SEAMED AND WHY. Exactly one edge: the `./db.js` specifier as imported
// BY lib/auth.js. The real lib/auth.js runs — its validation, its duplicate
// check, its first-user policy, its scrypt — and the real lib/db.js file backend
// serves every call the seam is not asked to fail, so the happy path and the
// duplicate path go end to end through the real datastore. lib/audit.js keeps
// the unseamed real db, so both modules share one instance and one file. The
// seam exists because the failures under test are a datastore that cannot be
// reached, and reaching a real one is exactly what a unit test must not do.
//
// NOTHING HERE REACHES A DATABASE OR A NETWORK. DATABASE_URL is removed before
// lib/db.js is imported, which is the only moment it reads it (lib/db.js:11), so
// the file backend takes the fixtures, in a temp directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.join(import.meta.dirname, '..');
const repoRootUrl = pathToFileURL(repoRoot + path.sep).href;
const realDbUrl = pathToFileURL(path.join(repoRoot, 'lib', 'db.js')).href;

// The needles. Written as literals because they are what the disclosure
// assertions hunt for, and a regex over a message this file writes itself would
// hold against a truncated or redacted version of it.
//
// The host and port are the PLACEHOLDER `<host>:<port>`, not an address: on a
// real deployment this fragment is the host and port of DATABASE_URL read out of
// the process environment by Node's connect error, and nothing in a test file
// should be mistakable for one. All the assertions need is that the substring is
// distinctive and that it is really in the fixture — which the controls below
// prove by counting it.
const CONNECT_REFUSED = 'connect ECONNREFUSED <host>:<port>';
// A real Postgres unique violation. Two jobs: it is a second class of escape
// (the datastore answered and refused, naming a schema object rather than an
// address), and it contains DOUBLE QUOTES. Task #38 nearly shipped a byte-search
// that read zero whether or not the field was served, because JSON escaped the
// quotes in the needle — so this fixture forces the onWire() form to be used.
const UNIQUE_VIOLATION =
  'duplicate key value violates unique constraint "users_username_key"';

// Counted, not matched. Asserting the needle occurs EXACTLY ONCE somewhere it is
// permitted, before asserting zero where it is withheld, is what separates "the
// mutation survived" from "the needle was never in the fixture at all".
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// The serialised form of a string, minus the wrapping quotes. UNIQUE_VIOLATION
// contains double quotes, which JSON escapes, so the raw string never appears in
// the bytes even when the field IS served. A byte search has to look for this
// form or it reads as zero either way.
const onWire = (s) => JSON.stringify(s).slice(1, -1);

// THE POSITIVE CONTROL FOR THE SEARCH ITSELF, and it is deliberately a copy of
// the vulnerable line this task removed (app/api/auth/register/route.js:22 as it
// was). If the route still did this, THIS is the body it would send; the tests
// assert the needle occurs exactly once in it. So a zero counted against the
// real route's body means the route withheld the message, and never that
// occurrences() cannot find it in a JSON body.
const vulnerableBody = (err) => JSON.stringify({ error: String(err?.message || err) });

// The failure injector. `failAt` names the db operation to throw from, so the
// escape happens INSIDE the real createUser rather than being handed to the
// route pre-made.
const seamSource = `
  const real = await import(${JSON.stringify(realDbUrl)});
  const fail = (op) => {
    const seam = globalThis.__philotasRegisterSeam;
    if (!seam || seam.failAt !== op) return;
    seam.thrownFrom = op;
    throw seam.failWith;
  };
  export const findUserByUsername = async (u) => { fail('findUserByUsername'); return real.findUserByUsername(u); };
  export const insertUser = async (user) => { fail('insertUser'); return real.insertUser(user); };
  export const insertSession = async (s) => { fail('insertSession'); return real.insertSession(s); };
  export const deleteSession = async (t) => { fail('deleteSession'); return real.deleteSession(t); };
  export const findUserByToken = async (t) => { fail('findUserByToken'); return real.findUserByToken(t); };
  export const countUsers = async () => { fail('countUsers'); return real.countUsers(); };
  // createUser joins the new account to a team after the insert, so this seam has
  // to carry that export too: a module seam is a COMPLETE substitute for the
  // specifier it replaces, and a missing export is a link-time failure of
  // lib/auth.js rather than a test that skips a case.
  export const addTeamMember = async (teamId, userId, joinedMs) => { fail('addTeamMember'); return real.addTeamMember(teamId, userId, joinedMs); };
`;
const seamUrl = `data:text/javascript,${encodeURIComponent(seamSource)}`;

// Route modules resolve their imports through the "@/" alias in jsconfig.json,
// which bare node does not understand. Same technique as
// test/status-route-schema.test.js and test/corpus-search-route.test.js, plus
// one extra clause: the relative './db.js' as imported by lib/auth.js is
// redirected to the seam. Keyed on the PARENT so lib/audit.js's identical
// specifier stays on the real module.
const loaderSource = `
  import fs from 'node:fs';
  import { fileURLToPath } from 'node:url';
  const repoRootUrl = ${JSON.stringify(repoRootUrl)};
  const seamUrl = ${JSON.stringify(seamUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === './db.js' && (context.parentURL || '').endsWith('/lib/auth.js')) {
      return { url: seamUrl, shortCircuit: true };
    }
    if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
    const base = new URL(specifier.slice(2), repoRootUrl).href;
    for (const candidate of [base, \`\${base}.js\`, \`\${base}/index.js\`]) {
      const candidatePath = fileURLToPath(candidate);
      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
        return { url: candidate, shortCircuit: true };
      }
    }
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

let POST;
let createUser;
let isDisclosable;

// One before() hook, deliberately not split: node:test runs multiple top-level
// before() hooks in one file concurrently rather than in registration order, so
// splitting "chdir" from "import" would race the import against the chdir — and
// lib/db.js:76 reads process.cwd() at import time.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-register-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  globalThis.__philotasRegisterSeam = { failAt: null, failWith: null };

  process.chdir(tempDir);

  ({ createUser } = await import('../lib/auth.js'));
  ({ isDisclosable } = await import('../lib/errors.js'));
  ({ POST } = await import('../app/api/auth/register/route.js'));
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  delete globalThis.__philotasRegisterSeam;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// A genuinely unauthenticated request: no cookie, nothing.
const registerRequest = (body) =>
  new Request('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// The route logs the withheld message server side by design, which is where an
// operator is supposed to read it. Captured rather than swallowed so the last
// test can assert it happened, and restored immediately so nothing else in this
// file can lose a real error.
async function capturingLogs(fn) {
  const realError = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); };
  try { return { result: await fn(), logged: lines.join('\n') }; }
  finally { console.error = realError; }
}

// Post while the datastore fails at `failAt` with `failWith`, then put the seam
// back. Returns the status, the exact bytes, and the server log.
async function postWhileFailing({ failAt, failWith, body }) {
  globalThis.__philotasRegisterSeam = { failAt, failWith, thrownFrom: null };
  try {
    const { result: res, logged } = await capturingLogs(() => POST(registerRequest(body)));
    const text = await res.text();
    // Non-vacuity: the seam really did throw from the operation this case is
    // about. Without it a case whose fixture stopped failing would assert
    // "no driver message on the wire" against a plain success and pass.
    assert.equal(
      globalThis.__philotasRegisterSeam.thrownFrom,
      failAt,
      `the seam never threw from ${failAt}, so this case tested nothing`
    );
    return { status: res.status, text, logged };
  } finally {
    globalThis.__philotasRegisterSeam = { failAt: null, failWith: null };
  }
}

test('the fixtures went to the throwaway datastore, not a real one', () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'a surviving DATABASE_URL would put these fixtures in a live database');
  assert.equal(process.cwd(), fs.realpathSync(tempDir), 'the file backend must be pointed at the temp directory');

  const realDatastore = path.join(originalCwd, '.data', 'philotas-db.json');
  const realContents = fs.existsSync(realDatastore) ? fs.readFileSync(realDatastore, 'utf8') : '';
  assert.doesNotMatch(realContents, /disclosure-first/, 'a fixture reached the real datastore');
});

test('a fresh username still registers, so the fix did not break the door', async () => {
  const res = await POST(registerRequest({ username: 'disclosure-first', password: 'not-a-real-password-1' }));
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.deepEqual(JSON.parse(text), { user: { username: 'disclosure-first' } });
  assert.match(res.headers.get('set-cookie') || '', /^philotas_session=[0-9a-f]{64};/, 'a successful registration still starts a session');

  const scratchDatastore = path.join(tempDir, '.data', 'philotas-db.json');
  assert.match(fs.readFileSync(scratchDatastore, 'utf8'), /disclosure-first/, 'the account was not actually written');
});

// KILLS: a fix implemented as "return a generic error for everything". That is
// the obvious wrong answer here and it makes the route unusable — a caller
// picking a taken name would be told only that something went wrong.
test('registration still tells an unauthenticated caller the username is taken', async () => {
  const res = await POST(registerRequest({ username: 'disclosure-first', password: 'not-a-real-password-2' }));
  const text = await res.text();

  assert.equal(res.status, 400, 'a taken username IS the caller\'s bad request');
  assert.equal(JSON.parse(text).error, 'username already taken');
  // The refusal is real, not a second account with the same name.
  const stored = JSON.parse(fs.readFileSync(path.join(tempDir, '.data', 'philotas-db.json'), 'utf8'));
  assert.equal(stored.users.filter((u) => u.username === 'disclosure-first').length, 1);
});

// KILLS: `String(err.message || err)` on the response — the leak this task is
// about. Restore that line and this test fails on the occurrences() assertion.
test('a datastore write failure never puts the connect message on the response', async () => {
  const thrown = new Error(CONNECT_REFUSED);

  // CONTROL, FIRST. The vulnerable serialisation of this exact fixture carries
  // the needle exactly once, so a zero below is the route withholding it and
  // never occurrences() failing to find it in a JSON body.
  assert.equal(occurrences(vulnerableBody(thrown), CONNECT_REFUSED), 1, 'the fixture never carried the needle');

  const { status, text } = await postWhileFailing({
    failAt: 'insertUser',
    failWith: thrown,
    body: { username: 'disclosure-write-fail', password: 'not-a-real-password-3' },
  });

  assert.equal(occurrences(text, CONNECT_REFUSED), 0, 'the host and port of DATABASE_URL reached an anonymous caller');
  assert.equal(occurrences(text, '<host>:<port>'), 0, 'the host and port reached an anonymous caller');
  assert.doesNotMatch(text, /ECONNREFUSED/, 'the driver message reached an anonymous caller');
  // And the caller is still told something useful about what happened.
  assert.equal(JSON.parse(text).error, 'registration is temporarily unavailable');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['error'], 'the response carries this one field and nothing else');
  assert.equal(status, 503);
});

// KILLS: the same forwarding for the OTHER class of escape, and any byte search
// that reads zero because JSON escaped the quotes in the needle.
test('a refused INSERT never puts the constraint name on the response', async () => {
  const thrown = new Error(UNIQUE_VIOLATION);

  // Two controls: the needle is in the fixture, AND the raw form is NOT what
  // appears in a JSON body — which is why the onWire form is the one counted.
  assert.equal(occurrences(vulnerableBody(thrown), onWire(UNIQUE_VIOLATION)), 1, 'the fixture never carried the needle');
  assert.equal(
    occurrences(vulnerableBody(thrown), UNIQUE_VIOLATION), 0,
    'the raw needle would have read zero even when served: this is the false pass onWire() exists to stop'
  );

  const { status, text } = await postWhileFailing({
    failAt: 'insertUser',
    failWith: thrown,
    body: { username: 'disclosure-constraint', password: 'not-a-real-password-4' },
  });

  assert.equal(occurrences(text, onWire(UNIQUE_VIOLATION)), 0, 'the constraint name reached an anonymous caller');
  assert.doesNotMatch(text, /users_username_key/, 'the schema object name reached an anonymous caller');
  assert.doesNotMatch(text, /duplicate key/, 'the driver message reached an anonymous caller');
  assert.equal(status, 503);
});

// ------------------------------------------------------------------- the race
//
// createUser checks for an existing username and then inserts, which is a SELECT
// followed by an INSERT with no lock between them. Two registrations for the same
// name arriving together both find nothing and both insert, and Postgres refuses
// the second one on users.username's UNIQUE constraint (lib/db.js:200) with
// SQLSTATE 23505. That escaped createUser as an ordinary driver error, so the
// route answered `503 registration is temporarily unavailable` — fail-closed and
// safe, and wrong: nothing is unavailable, the name is taken.
//
// Both duplicate paths now give one answer. What must NOT happen is the obvious
// way to get there: forwarding the driver's message. It names the constraint and
// the table, which is the exact class of disclosure this file exists to keep off
// this endpoint.
const PG_UNIQUE_VIOLATION_CODE = '23505';

// A unique violation shaped the way node-postgres raises one: the SQLSTATE on
// `code`, and a message that names a schema object. Both halves are load-bearing
// — the code is what the translation may key on, the message is what may not be
// forwarded. The fields beside them are what a real pg error carries, and they
// are here so a fix that serialises the error object fails.
const uniqueViolation = () => Object.assign(new Error(UNIQUE_VIOLATION), {
  code: PG_UNIQUE_VIOLATION_CODE,
  constraint: 'users_username_key',
  table: 'users',
  schema: 'public',
  severity: 'ERROR',
});

// KILLS: leaving the 23505 escape untranslated — the defect. Revert the
// translation in lib/auth.js and this fails on the status and on the message.
test('a duplicate that lost the race is answered as a taken username, not an outage', async () => {
  // CONTROL, FIRST, and the onWire form because UNIQUE_VIOLATION contains double
  // quotes. The vulnerable serialisation of this exact fixture carries the needle
  // exactly once, so the zeroes below are the route withholding it and never
  // occurrences() failing to find it in a JSON body.
  assert.equal(
    occurrences(vulnerableBody(uniqueViolation()), onWire(UNIQUE_VIOLATION)), 1,
    'the fixture never carried the needle'
  );

  const { status, text } = await postWhileFailing({
    failAt: 'insertUser',
    failWith: uniqueViolation(),
    body: { username: 'disclosure-race', password: 'not-a-real-password-12' },
  });

  assert.equal(status, 400, 'a taken username is the caller\'s bad request, not an outage');
  assert.equal(JSON.parse(text).error, 'username already taken');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['error'], 'the response carries this one field and nothing else');

  // KILLS: forwarding the driver's message instead of raising our own.
  assert.equal(occurrences(text, onWire(UNIQUE_VIOLATION)), 0, 'the constraint name reached an anonymous caller');
  assert.doesNotMatch(text, /users_username_key/, 'the schema object name reached an anonymous caller');
  assert.doesNotMatch(text, /duplicate key/, 'the driver message reached an anonymous caller');
  assert.doesNotMatch(text, /23505/, 'the SQLSTATE reached an anonymous caller');
  assert.doesNotMatch(text, /"table"|"schema"|"severity"/, 'the error object was serialised');
});

// KILLS: giving the race its own wording. Two messages for one fact tells a
// caller which of the two paths refused them, which is a statement about our
// concurrency and about the shape of the datastore underneath.
test('the race and the pre-check are one answer, byte for byte', async () => {
  const name = 'disclosure-race-twin';
  const created = await POST(registerRequest({ username: name, password: 'not-a-real-password-13' }));
  assert.equal(created.status, 200, 'the fixture account was not created, so neither path below is a duplicate');

  // The pre-check path: findUserByUsername finds the account and createUser
  // refuses before any INSERT is attempted. The real datastore, no seam.
  const preCheck = await POST(registerRequest({ username: name, password: 'not-a-real-password-14' }));
  const preCheckText = await preCheck.text();
  assert.equal(preCheck.status, 400, 'pinned as a literal, so "the two match" cannot mean they match on the wrong status');
  assert.equal(JSON.parse(preCheckText).error, 'username already taken');

  // The race path, and DELIBERATELY a name nothing has registered — that is what
  // a race is: both requests looked, both saw nothing, and the constraint refused
  // the second. Registering it first would send this down the pre-check instead
  // and the case would test nothing; postWhileFailing asserts the seam really
  // threw from insertUser, so that substitution cannot pass quietly.
  const race = await postWhileFailing({
    failAt: 'insertUser',
    failWith: uniqueViolation(),
    body: { username: 'disclosure-race-loser', password: 'not-a-real-password-15' },
  });

  assert.equal(race.status, preCheck.status, 'the two duplicate paths answer with different statuses');
  assert.equal(race.text, preCheckText, 'the two duplicate paths are distinguishable to a caller');
});

// KILLS: translating on the message text rather than on the SQLSTATE (the case
// above it, `new Error(UNIQUE_VIOLATION)` with no code, already has to stay a
// 503), and translating any error that happens to carry a `code`.
const NOT_A_UNIQUE_VIOLATION = [
  ['a connection failure with a code', Object.assign(new Error(CONNECT_REFUSED), { code: 'ECONNREFUSED' })],
  // A foreign-key violation. Adjacent SQLSTATE, adjacent wording, different fact.
  ['another integrity violation', Object.assign(
    new Error('insert or update on table "sessions" violates foreign key constraint "sessions_user_id_fkey"'),
    { code: '23503' }
  )],
];

test('only a unique violation is a duplicate; every other driver failure is still an outage', async () => {
  for (const [what, failWith] of NOT_A_UNIQUE_VIOLATION) {
    assert.notEqual(failWith.code, PG_UNIQUE_VIOLATION_CODE, `${what}: the fixture is the code under test`);

    const { status, text } = await postWhileFailing({
      failAt: 'insertUser',
      failWith,
      body: { username: `disclosure-not-unique-${failWith.code}`, password: 'not-a-real-password-16' },
    });

    assert.equal(status, 503, `${what} was reported as a taken username`);
    assert.equal(JSON.parse(text).error, 'registration is temporarily unavailable', `${what} produced a different body`);
    assert.doesNotMatch(text, /already taken/, `${what} was reported as a taken username`);
    assert.doesNotMatch(text, /fkey|ECONNREFUSED/, `${what} put the driver message on the wire`);
  }
});

// KILLS: a fix that catches everything and answers "username already taken",
// which would be the cheapest way to pass the two tests above and would report a
// dead datastore as a naming collision.
test('a failure in the duplicate CHECK is not reported as a duplicate', async () => {
  const { status, text } = await postWhileFailing({
    failAt: 'findUserByUsername',
    failWith: new Error(CONNECT_REFUSED),
    body: { username: 'disclosure-check-fail', password: 'not-a-real-password-5' },
  });

  assert.equal(status, 503, 'a datastore that cannot answer is not a bad request');
  assert.doesNotMatch(text, /already taken/, 'an unreachable datastore was reported as a taken username');
  assert.equal(occurrences(text, CONNECT_REFUSED), 0);

  const stored = JSON.parse(fs.readFileSync(path.join(tempDir, '.data', 'philotas-db.json'), 'utf8'));
  assert.equal(stored.users.some((u) => u.username === 'disclosure-check-fail'), false, 'the account was created anyway');
});

// KILLS: collapsing both outcomes onto one status. The two are different
// operational facts and a monitor has to be able to tell them apart without
// parsing prose.
test('the caller-caused refusal and the infrastructure failure are distinguishable by status', async () => {
  const refused = await POST(registerRequest({ username: 'disclosure-first', password: 'not-a-real-password-6' }));
  const broken = await postWhileFailing({
    failAt: 'insertUser',
    failWith: new Error(CONNECT_REFUSED),
    body: { username: 'disclosure-distinct', password: 'not-a-real-password-7' },
  });

  assert.equal(refused.status, 400);
  assert.equal(broken.status, 503);
  assert.notEqual(refused.status, broken.status, 'a broken datastore and a taken username became one signal');
});

// KILLS: `err.disclosable` written without the optional chain — `throw null`
// makes that a TypeError inside the catch, which escapes the handler entirely
// and hands the caller whatever the framework produces. Also kills serialising
// the error OBJECT, whose fields are the address and port when `message` is
// absent. `String(err.message || err)` treats these three differently and one of
// them yields the string "null".
const NON_ERROR_THROWS = [
  ['a plain string', CONNECT_REFUSED],
  ['null', null],
  ['an object with no message', { code: 'ECONNREFUSED', address: '<host>', port: '<port>', syscall: 'connect' }],
];

test('a thrown string, a thrown null and an object with no message are all withheld', async () => {
  for (const [what, failWith] of NON_ERROR_THROWS) {
    const { status, text } = await postWhileFailing({
      failAt: 'insertUser',
      failWith,
      body: { username: `disclosure-nonerror-${NON_ERROR_THROWS.findIndex((c) => c[0] === what)}`, password: 'not-a-real-password-8' },
    });

    assert.equal(status, 503, `${what} did not reach the infrastructure branch`);
    assert.equal(JSON.parse(text).error, 'registration is temporarily unavailable', `${what} produced a different body`);
    assert.equal(occurrences(text, '<host>'), 0, `${what} put the host on the wire`);
    assert.doesNotMatch(text, /ECONNREFUSED/, `${what} put the driver message on the wire`);
    // The specific trap in the old line: String(null || null) === 'null'.
    assert.doesNotMatch(text, /"null"/, `${what} serialised the thrown value itself`);
  }
});

// KILLS: dropping the message instead of moving it. The operator still needs to
// know the datastore is refusing connections; the change is WHERE that is
// readable, not whether it exists.
test('the withheld message still reaches the server log', async () => {
  const { logged } = await postWhileFailing({
    failAt: 'insertUser',
    failWith: new Error(CONNECT_REFUSED),
    body: { username: 'disclosure-logged', password: 'not-a-real-password-9' },
  });

  assert.equal(occurrences(logged, CONNECT_REFUSED), 1, 'the failure was swallowed: nobody can see why registration broke');
});

// ------------------------------------------------------- the library contract
//
// The route reads a brand rather than matching message text, and this is the
// half of the fix that lives in lib. KILLS: marking every error disclosable
// (which re-opens the leak on the next `throw` anyone adds under createUser),
// and marking neither (which takes "username already taken" away).
test('createUser marks its own refusals as disclosable and nothing else', async () => {
  await assert.rejects(
    () => createUser('disclosure-first', 'not-a-real-password-10'),
    (err) => {
      assert.equal(err.message, 'username already taken');
      assert.equal(isDisclosable(err), true, 'the answer a caller is entitled to was marked as an internal failure');
      return true;
    }
  );

  await assert.rejects(
    () => createUser('', ''),
    (err) => {
      assert.equal(err.message, 'username and password required');
      assert.equal(isDisclosable(err), true);
      return true;
    }
  );

  // The escaped case, driven through the real createUser rather than asserted
  // against a hand-made error: whatever the datastore throws must NOT come back
  // marked, or the route would forward it.
  globalThis.__philotasRegisterSeam = { failAt: 'insertUser', failWith: new Error(CONNECT_REFUSED), thrownFrom: null };
  try {
    await assert.rejects(
      () => createUser('disclosure-unmarked', 'not-a-real-password-11'),
      (err) => {
        assert.equal(err.message, CONNECT_REFUSED, 'the seam is not the error that came back');
        assert.equal(isDisclosable(err), false, 'a driver error came back marked as safe to send to the caller');
        return true;
      }
    );
  } finally {
    globalThis.__philotasRegisterSeam = { failAt: null, failWith: null };
  }

  // The three shapes the predicate has to survive being handed.
  assert.equal(isDisclosable(null), false, 'a null throw crashed the predicate instead of being refused');
  assert.equal(isDisclosable('username already taken'), false, 'a bare string is not a marked error');
  assert.equal(isDisclosable({ disclosable: 'yes' }), false, 'the brand is a true boolean, not any truthy value');
});

// Everything a caller could ever observe about an error, so the two duplicate
// refusals can be compared as objects rather than only as messages. `stack`
// differs by throw site and never leaves the process, so the NAMES are compared
// and not the values — which is what catches an extra field, `cause` above all:
// attaching the driver error there would keep its message reachable and would
// make the race's error a different object from the pre-check's.
const observableShape = (err) => ({
  message: err.message,
  name: err.name,
  disclosable: err.disclosable,
  ownProperties: Object.getOwnPropertyNames(err).sort(),
});

// KILLS: raising the driver's message under the disclosable brand — which passes
// every response-body assertion above only until someone reads what it says —
// and attaching the driver error as `cause`, which keeps the constraint name on
// an object the route is one careless serialisation away from sending.
test('createUser answers a lost race with the pre-check\'s own error, not the driver\'s', async () => {
  const preCheckError = await createUser('disclosure-first', 'not-a-real-password-17').then(
    () => assert.fail('the pre-check did not refuse a name that is already registered'),
    (err) => err
  );

  globalThis.__philotasRegisterSeam = { failAt: 'insertUser', failWith: uniqueViolation(), thrownFrom: null };
  let raceError;
  try {
    raceError = await createUser('disclosure-race-lib', 'not-a-real-password-18').then(
      () => assert.fail('the refused INSERT was swallowed and registration reported success'),
      (err) => err
    );
    assert.equal(globalThis.__philotasRegisterSeam.thrownFrom, 'insertUser', 'the seam never threw, so this tested nothing');
  } finally {
    globalThis.__philotasRegisterSeam = { failAt: null, failWith: null };
  }

  assert.equal(isDisclosable(raceError), true, 'the race stayed an internal failure, so the caller is told the service is broken');
  assert.equal(raceError.message, 'username already taken');
  assert.deepEqual(observableShape(raceError), observableShape(preCheckError), 'the two refusals are distinguishable');

  // Named separately from the deepEqual above so this fails by name.
  assert.doesNotMatch(raceError.message, /users_username_key|duplicate key|23505/, 'the driver message was forwarded');
  assert.equal(Object.hasOwn(raceError, 'cause'), false, 'the driver error rode along as a cause');
});
