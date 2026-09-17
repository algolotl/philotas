// Password auth + sessions.
//
// Passwords are scrypt-hashed with a per-user salt; sessions are random tokens
// kept in the datastore (file or Postgres — see lib/db.js) and carried in an
// httpOnly cookie.
//
// Three properties this file is responsible for, all of which it previously
// lacked and all of which matter once the application is reachable from the
// internet rather than from localhost:
//
//   1. Sessions expire SERVER SIDE. The cookie Max-Age is a hint to a client,
//      and a client that ignores it previously kept a valid session forever.
//   2. Hashing does not block the event loop. scryptSync costs ~100ms of
//      blocked thread per attempt, which is a denial of service anyone can
//      trigger by posting to the login route in a loop.
//   3. Login attempts are rate limited, so the same route is not also an
//      unthrottled password oracle.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import {
  findUserByUsername, insertUser, insertSession, deleteSession,
  findUserByToken, countUsers, addTeamMember,
} from './db.js';
import { DEFAULT_TEAM_ID } from './teams.js';
import { DisclosableError } from './errors.js';

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'parallax_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const SESSION_MAX_AGE_MS = MAX_AGE_SECONDS * 1000;

// Classification levels by clearance index.
export const CLASSES = ['UNCLASSIFIED', 'OFFICIAL', 'SECRET', 'TOP SECRET'];
// Role capability check: viewer < operator < admin.
const RANK = { viewer: 0, operator: 1, admin: 2 };
export function atLeast(role, min) { return (RANK[role] ?? -1) >= (RANK[min] ?? 99); }

async function hash(password, salt) {
  const derived = await scrypt(password, salt, 64);
  return derived.toString('hex');
}

// ---------------------------------------------------------------- rate limit
// Per-username sliding window. In-memory, so it is per-process: good enough to
// stop a password-guessing loop, and it degrades to per-replica under multiple
// replicas rather than failing open entirely.
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map(); // username -> number[] (timestamps)

function recentAttempts(username, now) {
  const list = (attempts.get(username) || []).filter((at) => now - at < ATTEMPT_WINDOW_MS);
  if (list.length) attempts.set(username, list); else attempts.delete(username);
  return list;
}

export function loginThrottled(username) {
  const now = Date.now();
  return recentAttempts(String(username || '').trim().toLowerCase(), now).length >= MAX_ATTEMPTS;
}

function recordAttempt(username) {
  const now = Date.now();
  const list = recentAttempts(username, now);
  list.push(now);
  attempts.set(username, list);
}

export function clearAttempts(username) {
  attempts.delete(String(username || '').trim().toLowerCase());
}

// ---------------------------------------------------------------- users

// The one thing this module says about a name that is already in use, written
// once because it is raised from two places — see the insert below. Two wordings
// for one fact would tell an unauthenticated caller WHICH of the two paths
// refused them, which is a statement about our concurrency and about the shape
// of the datastore underneath.
const USERNAME_TAKEN = 'username already taken';

// Postgres SQLSTATE 23505, unique_violation. lib/db.js declares users.username
// UNIQUE in BASE_SCHEMA_STATEMENTS — named rather than cited by line, because the
// line moved when that DDL became a constant — so this is what the datastore
// raises when a second
// INSERT for the same name gets past the check below. Keyed on the code rather
// than on the message, because the wording belongs to the driver and the
// SQLSTATE is the contract.
const PG_UNIQUE_VIOLATION = '23505';

export async function createUser(username, password, options = {}) {
  username = String(username || '').trim().toLowerCase();
  // DisclosableError, not Error: these two are the ANSWER to the request, and a
  // caller of an unauthenticated registration route is entitled to both. Marking
  // them is what lets app/api/auth/register/route.js forward these and only
  // these — the alternative it used to run, forwarding whatever it caught, put
  // the datastore's connect message on a public response. See lib/errors.js.
  if (!username || !password) throw new DisclosableError('username and password required');
  if (await findUserByUsername(username)) throw new DisclosableError(USERNAME_TAKEN);
  const salt = crypto.randomBytes(16).toString('hex');
  // First registered user is the admin with TOP SECRET clearance; others are
  // operators at OFFICIAL by default (an admin can change roles/clearance).
  const first = (await countUsers()) === 0;
  const role = options.role || (first ? 'admin' : 'operator');
  const clearance = options.clearance ?? (first ? 3 : 1);
  const user = {
    id: crypto.randomUUID(), username, salt,
    hash: await hash(password, salt),
    created: Date.now(), role, clearance,
  };
  try {
    await insertUser(user);
  } catch (err) {
    // A RACE, and the answer to it is the one the check above already gives.
    // That check is a SELECT and this is an INSERT with nothing holding the name
    // in between, so two registrations for the same username arriving together
    // both find nothing and both get here; the UNIQUE constraint refuses the
    // second. Escaping unmarked, it reached the caller of the unauthenticated
    // registration route as `503 registration is temporarily unavailable` —
    // fail-closed and safe, and wrong: nothing is unavailable and the true
    // answer is that the name is taken.
    //
    // The driver's own message is deliberately NOT forwarded. It names the
    // constraint and the table, which is the schema, and putting that on an
    // unauthenticated response is the class of disclosure commit 33efe18
    // removed from this endpoint. What goes out is the pre-check's message,
    // from the same constant, with nothing attached to it — not even a `cause`,
    // because an error carrying the driver's words is one careless
    // serialisation away from sending them. A caller cannot tell the two
    // refusals apart, which is the point of translating rather than inventing.
    if (err?.code === PG_UNIQUE_VIOLATION) throw new DisclosableError(USERNAME_TAKEN);
    throw err;
  }
  // A new account joins the default team, in ONE place for both backends rather
  // than in each insertUser. Registration by invitation will pass the
  // invitation's team through options.teamId instead.
  //
  // This is membership, never a ceiling: `clearance` above is still decided by
  // this function and read from the user row by everything downstream. See
  // lib/teams.js and the condition named in app/api/corpus/search/route.js.
  //
  // After the insert, deliberately: a name that lost the race above is refused
  // before anything joins it to a team.
  await addTeamMember(options.teamId || DEFAULT_TEAM_ID, user.id, user.created);
  return { id: user.id, username: user.username, role, clearance };
}

export async function authenticate(username, password) {
  username = String(username || '').trim().toLowerCase();
  const user = await findUserByUsername(username);
  if (!user) {
    recordAttempt(username);
    return null;
  }
  const candidate = await hash(password, user.salt);
  const candidateBuffer = Buffer.from(candidate, 'hex');
  const storedBuffer = Buffer.from(user.hash, 'hex');
  // timingSafeEqual throws on a length mismatch, which a stored hash written by
  // an older or different scheme would produce.
  const ok =
    candidateBuffer.length === storedBuffer.length &&
    crypto.timingSafeEqual(candidateBuffer, storedBuffer);
  if (!ok) {
    recordAttempt(username);
    return null;
  }
  clearAttempts(username);
  return { id: user.id, username: user.username };
}

// ---------------------------------------------------------------- sessions
export async function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await insertSession({ token, userId, created: Date.now() });
  return token;
}

export async function endSession(token) {
  await deleteSession(token);
}

export function tokenFromRequest(req) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(new RegExp(`${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export async function currentUser(req) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const user = await findUserByToken(token);
  if (!user) return null;

  // Expire server side. A session record with no timestamp predates this check
  // and is treated as expired rather than trusted.
  const createdMs = user.session_created_ms;
  if (createdMs == null || Date.now() - createdMs > SESSION_MAX_AGE_MS) {
    await deleteSession(token).catch(() => {});
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role || 'operator',
    // Absent clearance means UNCLASSIFIED, not OFFICIAL.
    //
    // This read defaulted to 1 while the other eight readers in the codebase
    // default to 0 — lib/corpus/scope.js, two in lib/db.js, four API routes and
    // the classification picker. Two answers to one question, and this was the
    // one that failed OPEN: a record with no clearance got OFFICIAL here and
    // UNCLASSIFIED from everything that reads the raw row.
    //
    // The 1 that IS correct sits in createUser above, where a new non-first
    // account is deliberately given OFFICIAL. That is a policy decision at
    // creation time. This is a fallback for a record that should not exist, and
    // a fallback's job is to be the least dangerous value rather than the usual
    // one.
    //
    // Measured 2026-08-17: no user record has a null clearance, locally
    // (boss 3, jones 2, trial 0) or on the trial database, where
    // `select count(*) from users where clearance is null` returned 0. So this
    // changes nobody's access today. It matters for records written by an
    // onboarding script during a per-client deployment, which is where the next
    // ones come from.
    clearance: user.clearance ?? 0,
  };
}

export function setCookie(token) {
  // Secure is set unless explicitly running plain HTTP for local development.
  const secure = process.env.ALLOW_INSECURE_COOKIE === '1' ? '' : ' Secure;';
  return `${COOKIE}=${token}; HttpOnly;${secure} Path=/; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}`;
}

export function clearCookie() {
  const secure = process.env.ALLOW_INSECURE_COOKIE === '1' ? '' : ' Secure;';
  return `${COOKIE}=; HttpOnly;${secure} Path=/; SameSite=Lax; Max-Age=0`;
}
