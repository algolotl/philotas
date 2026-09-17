// lib/corpus/scope.js
//
// The one place a session becomes a case scope.
//
// Spec section 8: every query against the chunk store carries a case predicate
// and a clearance ceiling, and the list of cases comes from the session — never
// from a request parameter. A caller able to name its own cases could read every
// case on the deployment, and the failure would not look like a failure: results
// come back, they are well ranked, and they are someone else's material. The
// deployment model makes that worse rather than better, since a per-client
// install has teams and workspaces inside one instance, so this boundary is the
// only thing between two of them.
//
// The scope has to be applied inside the query rather than to its results, and
// the measurement behind that — pre-filtered against post-filtered on a corpus
// large enough for the difference to show — is recorded at the top of
// lib/corpus/search.js with its date. This function exists so that query has
// something trustworthy to be given.
//
// A case IS a workspace. Parallax has no separate case-membership table, and the
// workspace lister imported below already implements the visibility rule this
// needs: the owner always, or shared and adequately cleared, or named on the
// workspace and adequately cleared. Reusing it is deliberate. A second
// membership model beside it would give two answers to one question about who
// can see what, and the weaker answer would eventually be the one some route
// happened to call.
//
// There is no case-list argument and no clearance argument, so there is no
// parameter to pass the wrong thing to. minRole only ever narrows: a route
// wanting operator or admin passes it, and no value of it widens a scope.
//
// Two paths deliberately return an empty scope rather than a wide one:
//
//   - The open-read escape hatch in lib/guard.js lets a viewer-level read
//     through with no user at all, for a closed network where the perimeter is
//     the control. That is a caller holding no cases, not a caller holding every
//     case, so the corpus stays shut to it even while the map does not.
//   - A session that holds no workspaces gets an empty list. Retrieval treats an
//     empty scope as a named refusal to search rather than as "no filter", and
//     this is where that precondition is established.
//
// If the datastore cannot say who the session can see, the workspace lister
// rejects and the rejection is left to propagate. That is the intended
// behaviour: a caller whose scope cannot be established has to fail visibly,
// not receive an empty scope that reads exactly like a search finding nothing.
// Do not wrap this in a catch that invents a scope.

import { requireUser } from '../guard.js';
import { listWorkspaces } from '../db.js';

export async function sessionScope(req, minRole = 'viewer') {
  const { user, response } = await requireUser(req, minRole);
  if (response) return { user: null, caseIds: [], clearance: 0, response };

  if (!user) return { user: null, caseIds: [], clearance: 0, response: null };

  const workspaces = await listWorkspaces(user);
  return {
    user,
    caseIds: workspaces.map((workspace) => workspace.id),
    // The ceiling is the session's own clearance. The zero default is a floor
    // for a user record written before clearances existed, never a fallback a
    // request can reach.
    clearance: user.clearance ?? 0,
    response: null,
  };
}
