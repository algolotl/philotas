// test/teams.test.js
//
// Teams are the MEMBERSHIP half of tenancy. The clearance half stays on the user
// row and is not touched here: nothing in this task derives a ceiling from a
// team, and the echo in app/api/corpus/search/route.js depends on that staying
// true. A team decides which shared material a session can reach (Task 2), never
// how highly cleared the session is.
//
// The backfill assertion below is the one that earns its place. A backfill that
// re-runs on every boot is not a backfill, it is a policy: it would re-add a user
// an administrator had deliberately removed from the default team, on the next
// restart, silently, and the symptom would be a workspace becoming visible again
// weeks later.
//
// Fixtures here are deliberately NOT uniform. Three accounts at three roles and
// three clearances, memberships across two different teams, and invitations for
// two different teams at two different clearances — because a fixture set where
// every row is the same value cannot distinguish "answered for the row asked
// about" from "answered for every row there is". Fifteen tests in this project
// once survived a mean-for-median mutation for exactly that reason.
//
// Same import discipline as test/corpus-scope.test.js and test/db.test.js:
// DATABASE_URL is set to an unusable value and then deleted, and the cwd moves to
// a throwaway directory, both BEFORE lib/db.js is imported, because it picks its
// backend and its file path at import time (lib/db.js:11). PHILOTAS_OPEN_READ,
// PHILOTAS_TRIAL and PHILOTAS_MARKINGS go too, so a surrounding shell cannot
// switch off the thing under test. Nothing in this file dials a database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read at module scope, which is evaluated before before() removes the variable —
// the one line in this file that has to see the real environment.
const HAVE_DB = !!process.env.DATABASE_URL;

let originalCwd;
let tempDir;
let previousDatabaseUrl;
let previousOpenRead;
let previousTrial;
let previousMarkings;

let createUser;
let teamIdsForUser, addTeamMember, removeTeamMember;
let insertInvitation, claimInvitation, listInvitations;
let applyBaseSchemaTwice, BASE_SCHEMA_STATEMENTS;
let DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME;

let admin, leaver, analyst;

// A second team, so every membership answer has something it could wrongly
// include. Task 1 has no team-creation accessor by design (nothing reads teams
// yet), and neither backend enforces a foreign key on team_id, so naming one is
// all a fixture needs.
const HARBOUR_TEAM_ID = 'team-harbour';

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

// One before() hook, deliberately not split in two: node:test runs multiple
// top-level before() hooks in the same file concurrently rather than in
// registration order, so splitting "chdir + import" from "seed fixtures" would
// race the import against the seed. Same note as test/corpus-scope.test.js.
before(async () => {
  originalCwd = process.cwd();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-teams-test-'));

  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/philotas-must-not-connect';
  delete process.env.DATABASE_URL;

  previousOpenRead = process.env.PHILOTAS_OPEN_READ;
  delete process.env.PHILOTAS_OPEN_READ;
  previousTrial = process.env.PHILOTAS_TRIAL;
  delete process.env.PHILOTAS_TRIAL;
  previousMarkings = process.env.PHILOTAS_MARKINGS;
  delete process.env.PHILOTAS_MARKINGS;

  process.chdir(tempDir);

  ({ createUser } = await import('../lib/auth.js'));
  ({
    teamIdsForUser, addTeamMember, removeTeamMember,
    insertInvitation, claimInvitation, listInvitations,
    applyBaseSchemaTwice, BASE_SCHEMA_STATEMENTS,
  } = await import('../lib/db.js'));
  ({ DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME } = await import('../lib/teams.js'));

  // Three accounts, three roles, three clearances. The first registered account
  // is the admin at TOP SECRET by lib/auth.js's own policy; the other two are
  // written the way an onboarding script writes them.
  admin = await createUser('teams-admin', 'not-a-real-password-1');
  leaver = await createUser('teams-leaver', 'not-a-real-password-2', { role: 'operator', clearance: 1 });
  analyst = await createUser('teams-analyst', 'not-a-real-password-3', { role: 'viewer', clearance: 0 });
});

after(() => {
  process.chdir(originalCwd);
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousOpenRead === undefined) delete process.env.PHILOTAS_OPEN_READ;
  else process.env.PHILOTAS_OPEN_READ = previousOpenRead;
  if (previousTrial === undefined) delete process.env.PHILOTAS_TRIAL;
  else process.env.PHILOTAS_TRIAL = previousTrial;
  if (previousMarkings === undefined) delete process.env.PHILOTAS_MARKINGS;
  else process.env.PHILOTAS_MARKINGS = previousMarkings;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the fixtures went to the throwaway datastore, not a real one', () => {
  assert.equal(process.env.DATABASE_URL, undefined, 'a surviving DATABASE_URL would put these fixtures in a live database');
  const scratch = path.join(tempDir, '.data', 'philotas-db.json');
  assert.ok(fs.existsSync(scratch), 'the file backend wrote the fixtures under the temp directory');
  const written = JSON.parse(fs.readFileSync(scratch, 'utf8'));
  assert.deepEqual(
    written.users.map((u) => u.username).sort(),
    ['teams-admin', 'teams-analyst', 'teams-leaver'],
    'and these three accounts are in that file rather than somewhere a deployment can see'
  );
});

test('a new account joins the default team', async () => {
  assert.deepEqual(await teamIdsForUser(admin.id), [DEFAULT_TEAM_ID]);
  // The literal too, so moving the constant is a decision someone makes rather
  // than a rename that silently repoints every instance's default team.
  assert.equal(DEFAULT_TEAM_ID, 'team-default');
  assert.equal(DEFAULT_TEAM_NAME, 'Default');
});

test('membership is per user: a second team reaches its own member and nobody else', async () => {
  await addTeamMember(HARBOUR_TEAM_ID, analyst.id, Date.now() + 1_000);

  assert.deepEqual(
    await teamIdsForUser(analyst.id),
    [DEFAULT_TEAM_ID, HARBOUR_TEAM_ID],
    'both teams, oldest membership first'
  );
  assert.deepEqual(
    await teamIdsForUser(admin.id),
    [DEFAULT_TEAM_ID],
    'the admin joined no second team, so a lister that returns every team that exists fails here'
  );
  assert.deepEqual(await teamIdsForUser(leaver.id), [DEFAULT_TEAM_ID]);
});

test('the default-team backfill runs once and does not re-add a removed member', async () => {
  assert.deepEqual(await teamIdsForUser(leaver.id), [DEFAULT_TEAM_ID], 'non-vacuity: the member was there to remove');

  await removeTeamMember(DEFAULT_TEAM_ID, leaver.id);
  assert.deepEqual(await teamIdsForUser(leaver.id), [], 'the removal took effect');

  // The other two memberships survive, which is what makes this fixture negative
  // for the right reason: the backfill guard is "some membership exists", so a
  // table emptied by the removal would entitle the backfill to run again and the
  // assertion below could not tell a working guard from a missing one.
  assert.ok((await teamIdsForUser(admin.id)).length > 0, 'non-vacuity: memberships remain, so the guard is what is under test');

  // The backfill is what a restart re-runs. Applying it again must be inert.
  await applyBaseSchemaTwice();
  assert.deepEqual(
    await teamIdsForUser(leaver.id),
    [],
    'a restart must not re-add a member an administrator removed'
  );
});

test('a user in no team resolves to an empty list, not to every team', async () => {
  assert.ok((await teamIdsForUser(analyst.id)).length > 0, 'non-vacuity: this lister does answer with teams when there are some');
  assert.deepEqual(await teamIdsForUser('a-user-id-that-was-never-created'), []);
  assert.deepEqual(await teamIdsForUser(undefined), [], 'and a missing id is not a wildcard');
});

test('an invitation is claimed exactly once', async () => {
  const issuedMs = Date.now();
  await insertInvitation({
    tokenHash: 'hash-single-use', teamId: DEFAULT_TEAM_ID, role: 'operator', clearance: 2,
    issuedBy: admin.id, issuedMs, expiresMs: issuedMs + 60_000,
  });

  const claimed = await claimInvitation('hash-single-use', issuedMs + 1_000, analyst.id);
  assert.deepEqual(claimed, { team_id: DEFAULT_TEAM_ID, role: 'operator', clearance: 2 });

  const second = await claimInvitation('hash-single-use', issuedMs + 2_000, leaver.id);
  assert.equal(second, null, 'one invitation must not create two accounts');
});

test('an expired invitation is refused, and refused the same way an unknown one is', async () => {
  const issuedMs = Date.now();
  await insertInvitation({
    tokenHash: 'hash-expired', teamId: DEFAULT_TEAM_ID, role: 'operator', clearance: 1,
    issuedBy: admin.id, issuedMs: issuedMs - 120_000, expiresMs: issuedMs - 1,
  });

  // Non-vacuity: the row exists and is the only thing wrong with it is its age.
  const stored = (await listInvitations([DEFAULT_TEAM_ID])).find((row) => row.token_hash === 'hash-expired');
  assert.ok(stored, 'the expired invitation was really written');
  assert.equal(stored.accepted_ms, null, 'and it is unclaimed, so expiry is the only reason it can be refused');

  assert.equal(await claimInvitation('hash-expired', issuedMs, analyst.id), null);
  assert.equal(
    await claimInvitation('hash-never-issued-at-all', issuedMs, analyst.id),
    null,
    'used, expired and never-existed are one refusal, so a probe learns nothing from the difference'
  );
});

test('an invitation with no clearance resolves to 0, not to OFFICIAL', async () => {
  const issuedMs = Date.now();
  await insertInvitation({
    tokenHash: 'hash-no-clearance', teamId: HARBOUR_TEAM_ID, role: 'viewer',
    issuedBy: admin.id, issuedMs, expiresMs: issuedMs + 60_000,
  });

  const claimed = await claimInvitation('hash-no-clearance', issuedMs + 1, leaver.id);
  assert.equal(claimed.clearance, 0, 'an absent clearance is UNCLASSIFIED');
  // The `?? 1` that is correct in createUser is a policy decision at creation
  // time. This is a fallback for a row that should not exist, and the comment on
  // currentUser in lib/auth.js records what it cost the last time those two were
  // confused: one reader answered OFFICIAL where the other eight answered
  // UNCLASSIFIED.
  assert.notEqual(claimed.clearance, 1);
});

test('listInvitations answers for the teams asked about and no others', async () => {
  const harbour = await listInvitations([HARBOUR_TEAM_ID]);
  assert.deepEqual(harbour.map((row) => row.token_hash), ['hash-no-clearance']);
  assert.equal(harbour[0].clearance, 0, 'and the stored clearance is the one that was written');

  // Non-vacuity: the invitations withheld above are reachable when asked for, so
  // the single-element answer is a filter working rather than an empty table.
  const both = await listInvitations([DEFAULT_TEAM_ID, HARBOUR_TEAM_ID]);
  assert.deepEqual(
    both.map((row) => row.token_hash).sort(),
    ['hash-expired', 'hash-no-clearance', 'hash-single-use']
  );
  assert.deepEqual(await listInvitations([]), [], 'no teams is no invitations, never all of them');
});

test('the boot DDL creates the team tables and carries both one-shot guards', () => {
  // TEXT, not behaviour. This runs without a database and so it pins what will be
  // SENT to Postgres, not what Postgres does with it — the behaviour is the gated
  // test below, and on a laptop that one is skipped rather than passed. Worth
  // having anyway: without it, deleting the SQL guard leaves the whole suite green
  // because only the JavaScript backend runs here.
  const sql = BASE_SCHEMA_STATEMENTS.join('\n');

  assert.equal(occurrences(sql, 'CREATE TABLE IF NOT EXISTS teams'), 1);
  assert.equal(occurrences(sql, 'CREATE TABLE IF NOT EXISTS team_members'), 1);
  assert.equal(occurrences(sql, 'CREATE TABLE IF NOT EXISTS invitations'), 1);
  assert.equal(occurrences(sql, 'CREATE TABLE IF NOT EXISTS users'), 1, 'and the tables it already created are still there');

  assert.equal(
    occurrences(sql, 'WHERE NOT EXISTS (SELECT 1 FROM team_members)'),
    1,
    'the member backfill guard, exactly once — an unguarded backfill re-adds a removed member on every restart'
  );
  assert.equal(
    occurrences(sql, 'AND NOT EXISTS (SELECT 1 FROM workspaces WHERE team_id IS NOT NULL)'),
    1,
    'the workspace backfill guard, exactly once — without it a NULL team_id gets widened into the default team on every restart'
  );
});

test('the Postgres backfill guard survives a second boot', async (t) => {
  // A SKIPPED TEST IS NOT A PASSED ONE. Without DATABASE_URL this reports skipped
  // and the suite still says `# fail 0`, and the SQL one-shot guard — the only one
  // of the two that runs in production — is then unverified. The JavaScript guard
  // above and this one are two implementations of one rule; a laptop run exercises
  // the implementation that is not deployed.
  if (!HAVE_DB) return t.skip('DATABASE_URL not set — a skipped test is not a passed one: the Postgres one-shot backfill guard is UNVERIFIED');

  // Its own pool, from the real connection string, because this file has
  // deliberately pointed lib/db.js at the file backend. Same shape as
  // test/frames-postgres.test.js.
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
  // The boot path applies the base schema as ONE multi-statement query, which is
  // one implicit transaction in Postgres. Running it the same way here is what
  // makes this a second process start rather than an approximation of one.
  const boot = () => pool.query(BASE_SCHEMA_STATEMENTS.join('\n'));

  const removedUserId = `teams-test-removed-${crypto.randomUUID()}`;
  const stayingUserId = `teams-test-staying-${crypto.randomUUID()}`;
  const insertUser = (id) => pool.query(
    'INSERT INTO users(id,username,salt,hash,created,role,clearance) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, id, 'not-a-real-salt', 'not-a-real-hash', Date.now(), 'operator', 0]
  );
  const joinDefaultTeam = (id) => pool.query(
    'INSERT INTO team_members(team_id,user_id,joined_ms) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    ['team-default', id, Date.now()]
  );

  try {
    await boot();
    await insertUser(removedUserId);
    await insertUser(stayingUserId);
    await joinDefaultTeam(removedUserId);
    await joinDefaultTeam(stayingUserId);

    const before = await pool.query('SELECT 1 FROM team_members WHERE user_id=$1', [removedUserId]);
    assert.equal(before.rowCount, 1, 'non-vacuity: the membership existed to be removed');

    await pool.query('DELETE FROM team_members WHERE user_id=$1', [removedUserId]);

    // The second fixture is what keeps this negative for the right reason. The
    // guard is "no membership exists at all", so against an EMPTY team_members the
    // backfill is entitled to re-add everyone and a re-added row would prove
    // nothing about the guard.
    const remaining = await pool.query('SELECT COUNT(*)::int AS n FROM team_members');
    assert.ok(remaining.rows[0].n > 0, 'memberships remain, so the guard rather than an empty table is what is under test');

    await boot();

    const after = await pool.query('SELECT 1 FROM team_members WHERE user_id=$1', [removedUserId]);
    assert.equal(after.rowCount, 0, 'a restart must not re-add a member an administrator removed');
  } finally {
    // Cleanup has to run even when an assertion above failed, and a cleanup
    // failure must not overwrite the failure that matters. Each statement is
    // therefore allowed to fail on its own rather than under one catch that would
    // swallow the real error too.
    for (const id of [removedUserId, stayingUserId]) {
      await pool.query('DELETE FROM team_members WHERE user_id=$1', [id]).catch((err) => err);
      await pool.query('DELETE FROM users WHERE id=$1', [id]).catch((err) => err);
    }
    await pool.end();
  }
});
