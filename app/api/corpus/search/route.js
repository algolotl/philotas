// GET /api/corpus/search?q=<text>&limit=<n> — hybrid retrieval over the case
// corpus, scoped to the requesting session.
//
// There is no caseIds parameter and there will not be one. Scope comes from
// lib/corpus/scope.js, which reads the session and never the URL: a caller able
// to name its own cases could read every case on the deployment, and the result
// would look exactly like a working search rather than like a breach. Parallax
// ships as a per-client install with teams and workspaces inside one instance,
// so this predicate is the only thing between two of them.
//
// The response reports HOW MANY cases were searched, never WHICH. Echoing the
// ids was defensible on the grounds that they are the caller's own, and that is
// true today only because scope is currently owner-or-shared. It stops being
// true the moment a scope includes an id the caller would not otherwise learn —
// a case inherited through a team, a group share — and at that point the echo is
// a disclosure channel that nothing in the route would flag. The count answers
// the question an operator actually has, which is whether the search was scoped
// and to how much, and it cannot become a leak later.
//
// `clearance` IS echoed, and the asymmetry with the case ids is deliberate.
// app/api/auth/me/route.js already returns it to the holder of the session, so it
// is not a new channel, and lib/corpus/scope.js sets it from `user.clearance` and
// from nothing else — under group sharing or inherited team cases it stays a
// property of the requesting user record, where caseIds under those same models
// would carry identifiers naming objects the caller never asked about. THE
// CONDITION UNDER WHICH THAT STOPS HOLDING: if clearance ever becomes an
// effective ceiling derived from a team or a per-case policy rather than from the
// user row, the echo starts reporting a value computed from someone else's
// configuration, and the argument that removed the caseIds echo applies to it
// too. Whoever writes that change owns this line.
//
// sessionScope can reject, and that rejection is deliberately not caught here.
// A caller whose scope cannot be established has to fail visibly: an invented
// empty scope reads exactly like a search that found nothing, which is the one
// answer an operator must never be given by accident. See the note at the foot
// of lib/corpus/scope.js.

import { sessionScope } from '@/lib/corpus/scope';
import { semanticPool } from '@/lib/db';
import { searchChunks } from '@/lib/corpus/search';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Both **assumed**, not measured. MIN_QUERY_LENGTH exists so a stray keystroke
// in a search box does not become a two-leg retrieval over the whole corpus;
// MAX_LIMIT bounds how much a single request can ask the reranker to score.
// Revisit either with a measurement from the trial rather than by taste.
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

// Every response from this route carries the session's own scope, so none of
// them may be held by a shared cache and served to a different session — the
// degraded answers included, since they report the scope too.
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function GET(req) {
  const { caseIds, clearance, response: denied } = await sessionScope(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const query = (url.searchParams.get('q') || '').trim();
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '', 10);
  const limit = Math.min(
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT,
    MAX_LIMIT
  );

  const scope = { caseCount: caseIds.length, clearance };

  // Every exit below carries the same four-plus-one envelope, including
  // `mixedEmbedModelExcluded` at zero on the exits where no search ran. Same
  // reasoning as the four exits inside lib/corpus/search.js: a field whose
  // presence depends on which path answered is a field every consumer needs a
  // guard for, and an absent count reads as "nobody looked" rather than "nothing
  // was held back".

  // Not a degradation. Nothing failed and nothing was withheld — there was no
  // question, so `degraded` stays null and an operator is not sent looking for a
  // fault that does not exist.
  if (query.length < MIN_QUERY_LENGTH) {
    return Response.json(
      { q: query, scope, hits: [], degraded: null, mixedEmbedModelExcluded: 0 },
      { headers: NO_STORE }
    );
  }

  // UNGUARDED ON PURPOSE, and the hazard has a name. lib/db.js's Postgres
  // backend REJECTS here when the database cannot be reached, and Node's connect
  // error message is the host and port of DATABASE_URL. Nothing serialises it
  // today: the rejection escapes the handler and Next answers with its own
  // opaque 500, which says nothing about us. Wrapping this in a catch that
  // reports what went wrong is how that message would reach a caller — the same
  // defect lib/errors.js and commit 33efe18 removed from the registration route.
  // If this ever needs handling, degrade by NAME the way the null branch below
  // does, and never from err.message.
  const pool = await semanticPool();
  if (!pool) {
    // Named, not empty. "The corpus needs Postgres" and "your search found
    // nothing" are different answers and an operator has to be able to tell them
    // apart. lib/db.js's file backend returns null here by design.
    return Response.json(
      { q: query, scope, hits: [], degraded: 'no-corpus-store', mixedEmbedModelExcluded: 0 },
      { headers: NO_STORE }
    );
  }

  // `degraded` is passed through as retrieval reported it, including the
  // comma-joined form lib/corpus/search.js uses when more than one of the dense
  // leg, the exclusion count and the reranker are down. Flattening it to a
  // boolean here would tell an operator that something was wrong without saying
  // what.
  //
  // `mixedEmbedModelExcluded` is surfaced rather than kept at the library
  // boundary, and that is the whole point of the guard behind it: the dense leg
  // now excludes chunks embedded by a different service, and a case with 900
  // chunks nobody re-embedded would otherwise look to a user exactly like a case
  // with nothing in it. The number is a property of the SEARCH, not of a row, so
  // it belongs on the envelope — putting it on each hit would duplicate it and
  // break the hit key set for no benefit.
  const { hits, degraded, mixedEmbedModelExcluded } = await searchChunks(pool, {
    query,
    caseIds,
    clearance,
    limit,
  });

  // The hits are PROJECTED, not passed through. lib/corpus/search.js fuses two
  // legs and hands back its working state along with the result — `rrf`, plus a
  // `dense_rank` and `lexical_rank` per hit — and passing those on made three
  // retrieval internals part of this route's contract by accident. None of them
  // crosses the case boundary, so this is contract drift rather than disclosure,
  // but Task 4 and any UI will be written against whatever this route returns and
  // `dense_rank` becomes load-bearing the moment something reads it.
  //
  // The additive case is not worthless: the fusion ranks say how many legs ran
  // and how each performed, which is exactly what an operator wants when a result
  // set looks wrong. It is refused here only because it should be a declared
  // decision rather than a field arriving from a layer below — if it is wanted,
  // widen the contract deliberately and widen the asserted key set with it.
  //
  // That procedure is what `mixedEmbedModelExcluded` above went through, and
  // doing it exposed a hole in this claim as it was originally written. It said
  // test/corpus-search-route.test.js "pins the key set exactly, so a field added
  // upstream cannot rejoin this response quietly". True of HIT fields, which were
  // what this paragraph was about, and false of the ENVELOPE: the only key-set
  // assertion was on `Object.keys(body.hits[0])`, so a field added to the
  // top-level response rejoined it silently — exactly the drift this projection
  // exists to stop, one level up. Both key sets are pinned now.
  //
  // It also catches an upstream RENAME, which is less obvious and was measured
  // on 2026-08-17 rather than assumed: a renamed source field makes the
  // destructure yield undefined, JSON.stringify drops undefined-valued keys, and
  // the parsed body arrives with three keys rather than four — so the same
  // assertion fails. This projection being a hand-written field list is
  // therefore not the exposure it looks like.
  const served = hits.map(({ id, doc_id, content, score }) => ({ id, doc_id, content, score }));
  return Response.json(
    { q: query, scope, hits: served, degraded, mixedEmbedModelExcluded },
    { headers: NO_STORE }
  );
}
