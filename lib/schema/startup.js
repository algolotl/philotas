// lib/schema/startup.js
//
// Applies the semantic schema once, at process start.
//
// lib/schema/apply.js has existed since increment 2 and nothing called it:
// `git grep -n applySemanticSchema 3c53c33 -- app lib`, run 2026-08-17, returned
// ONE line — its own definition at lib/schema/apply.js:15. That commit is the one
// before this file existed, and the commit is named on purpose: the same grep at
// HEAD returns four lines, three of them the import and default parameter below,
// so a bare "grep returns one line" claim would falsify itself the moment this
// file landed. On a fresh deployment the documents, chunks, entity_profiles and
// entity_links tables were therefore never created, and every query against them
// failed with an undefined-table error attributed to whichever feature happened to
// run first. This file is the missing call site.
//
// IT NEVER THROWS, and that is the design point rather than defensiveness. A
// boot that dies because the DDL was refused takes the map, the feeds and the
// whole read surface down with it, and none of those need the semantic schema.
// Every failure is named, logged once, and readable afterwards through
// lastStartupResult() so an operator can see why retrieval is empty rather than
// having to infer it.
//
// The named outcomes are not interchangeable, and `applied: false` DOES NOT MEAN
// BROKEN. Every value lastStartupResult() can hold, and how a health surface has
// to read it:
//
//   applied: true                    healthy   the schema was applied just now
//   applied: false, already-applied  HEALTHY   the schema is already there. From
//                                              lib/schema/apply.js:17, whose
//                                              in-process guard returns
//                                              applied:false for a no-op.
//   applied: false, no-pool          expected  the file backend: dev, no Postgres
//                                              configured, nothing wrong, but the
//                                              semantic layer is inactive
//   applied: false, no-database       expected  a pool was passed with no
//                                              DATABASE_URL set (apply.js:16)
//   applied: false, pool-failed      DEGRADED  Postgres is configured and would
//                                              not accept a connection: wait, or
//                                              fix the network
//   applied: false, schema-failed    DEGRADED  Postgres answered and refused the
//                                              DDL: fix a grant, usually
//                                              CREATE EXTENSION vector
//
// The first trap is treating pool-failed and schema-failed as one signal, which
// sends an operator to the wrong place. The second is for whoever puts this on
// /api/status: `if (!applied) → degraded` reports a correctly provisioned
// deployment as broken. The guard behind already-applied is module state
// (lib/schema/apply.js:13), so it is the process's SECOND CALL that reports it,
// not its second boot — a status handler that calls ensureSemanticSchema() itself
// instead of reading lastStartupResult() would hit it on the first request it
// serves. Classify by reason, never by the boolean alone.

import { semanticPool } from '../db.js';
import { applySemanticSchema } from './apply.js';

let lastResult = null;

/** The outcome of the most recent startup attempt, for operator surfaces. */
export function lastStartupResult() { return lastResult; }

/** Exported for tests only. */
export function _resetStartupResult() { lastResult = null; }

// The table in the header above, as code, so no health surface has to retype it.
// Both traps named up there are traps precisely because they are easy to get
// wrong from memory at a call site: `applied: false` covers two HEALTHY outcomes
// and two expected ones, and the two DEGRADED reasons must not collapse into one
// signal because they send an operator to different places.
const STATUS_BY_REASON = {
  applied: 'healthy',
  'already-applied': 'healthy',
  'no-pool': 'inactive',
  'no-database': 'inactive',
  'pool-failed': 'degraded',
  'schema-failed': 'degraded',
};

/**
 * The startup outcome as a health surface should publish it: a coarse status to
 * act on, the reason verbatim so the two degradations stay separable, and — for a
 * caller entitled to it — the detail an operator needs to fix the right thing.
 *
 * `status` and `reason` ARE NOT SENSITIVE and `detail` IS. detailOf() below is
 * the driver's own message, and for the pool-failed case Node writes it as
 * `connect ECONNREFUSED <host>:<port>`: the host and port of DATABASE_URL, taken
 * out of the unit environment on the deployed host. The schema-failed message is
 * milder and the same shape of problem — it names grants, roles and extensions,
 * which is internal configuration. Both ride on this one field, so gating the
 * field covers both.
 *
 * DROPPING `detail` WOULD HAVE BEEN THE WRONG FIX. The distinction the header
 * table above exists to protect — pool-failed sends an operator to the network,
 * schema-failed sends them to a grant — is carried by `reason`, which is why an
 * unprivileged caller keeps it. `detail` adds the specific message, and an
 * operator surface without it is a diagnosis done blind.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeDetail=false] whether the caller may read the
 *   driver message. DEFAULTS TO FALSE ON PURPOSE: a new call site that has not
 *   thought about who is reading gets the safe answer, and has to ask for the
 *   sensitive one in writing. The decision itself is not made here — it is a
 *   question about a request, so it belongs at the route with the session in
 *   hand (app/api/status/route.js).
 *
 * WHAT AN ABSENT `detail` LOOKS LIKE: the key is OMITTED, not set to null. null
 * already means something here — 'applied', 'already-applied' and the unknown
 * outcome genuinely have nothing to explain, and they still report null to a
 * caller who may see the field. Publishing null for a withheld detail would tell
 * a viewer looking at pool-failed that the boot recorded no explanation, when one
 * exists and they are not cleared for it. An absent key says "not part of your
 * view"; null says "yours, and empty". Pinned in test/status-route-schema.test.js.
 *
 * Reads lastStartupResult(). It does NOT apply anything, and taking no pool
 * argument is part of that — see the second trap in the header.
 */
export function startupSchemaHealth({ includeDetail = false } = {}) {
  // No boot attempt was recorded at all. Deliberately a state of its own rather
  // than folded into 'healthy': a null that reads as healthy is the same silent
  // failure this file exists to end, one level further out.
  const health = { status: 'unknown', reason: null };
  if (lastResult) {
    // The boolean names the reason for the success case and decides nothing else.
    // apply.js:23 returns a bare { applied: true } with no reason at all, while
    // every applied:false outcome carries one, so this is the only thing the flag
    // is read for.
    health.reason = lastResult.applied === true ? 'applied' : (lastResult.reason ?? null);
    // An unrecognised reason is 'unknown', never 'healthy'. A reason added to
    // apply.js later has to be classified here on purpose rather than default
    // into looking fine.
    health.status = STATUS_BY_REASON[health.reason] || 'unknown';
  }
  if (includeDetail) health.detail = lastResult?.detail ?? null;
  return health;
}

/**
 * @param {object}  [options]
 * @param {object|Promise<object>} [options.pool] the pool, or a promise of one.
 *   Defaults to lib/db.js's semanticPool(), which on Postgres REJECTS when the
 *   database is unreachable — hence the await below sitting inside the try.
 * @param {Function} [options.apply] the applier, for tests.
 */
export async function ensureSemanticSchema({ pool, apply = applySemanticSchema } = {}) {
  let target;
  try {
    // Acquiring the pool is inside the guard, not before it. On the Postgres
    // backend this await reaches pgBackend's init(), which connects and runs the
    // base DDL, so it is the MOST likely thing here to reject on a real deploy —
    // a database that is not accepting connections yet. Left outside a try it
    // would propagate out of register() as an unhandled rejection in the Next.js
    // instrumentation hook, which is the one outcome this file exists to prevent.
    target = await (pool === undefined ? semanticPool() : pool);
  } catch (err) {
    lastResult = { applied: false, reason: 'pool-failed', detail: detailOf(err) };
    console.error(`[schema] no Postgres pool at startup, so the semantic layer is inactive and retrieval will return nothing: ${lastResult.detail}`);
    return lastResult;
  }

  if (!target) {
    lastResult = { applied: false, reason: 'no-pool' };
    console.log('[schema] no semantic pool (file backend): the semantic layer is inactive and retrieval will return nothing');
    return lastResult;
  }

  try {
    lastResult = await apply(target);
  } catch (err) {
    lastResult = { applied: false, reason: 'schema-failed', detail: detailOf(err) };
    console.error(`[schema] the semantic schema was NOT applied: ${lastResult.detail}`);
  }
  return lastResult;
}

// A rejected DDL usually arrives as a pg error whose message names the missing
// grant or extension, but a thrown string or a null would otherwise land in the
// operator log as "undefined", which says nothing.
function detailOf(err) { return String(err?.message || err || 'unknown error'); }
