// Route guard.
//
// Before this existed the entire read surface took no user at all: feeds,
// graph, search, ontology, history, alerts and the operator action log were
// readable by anyone who knew the URL. That was survivable on localhost and is
// not survivable on a public host, which is where this build is going.
//
// Usage in a route handler:
//
//   const { user, response } = await requireUser(req);
//   if (response) return response;
//
// The guard returns the response rather than throwing so route handlers stay
// plain functions and the failure path is visible at the call site.

import { currentUser, atLeast } from './auth.js';

// Set PARALLAX_OPEN_READ=1 to drop the read gate entirely. Intended for a
// closed network where the perimeter is the control, never for a public host.
// It is deliberately awkward to enable and logged once at first use.
let openReadWarned = false;
function openRead() {
  const on = process.env.PARALLAX_OPEN_READ === '1';
  if (on && !openReadWarned) {
    openReadWarned = true;
    console.warn('[guard] PARALLAX_OPEN_READ=1 — read routes are unauthenticated');
  }
  return on;
}

const unauthorised = () =>
  Response.json({ error: 'authentication required' }, { status: 401 });

const forbidden = (minRole) =>
  Response.json({ error: `${minRole} role required` }, { status: 403 });

// Require a signed-in user, optionally at a minimum role.
export async function requireUser(req, minRole = 'viewer') {
  const user = await currentUser(req);
  if (!user) {
    // The open-read escape hatch applies to viewer-level reads only. Anything
    // needing operator or admin always requires a real session.
    if (minRole === 'viewer' && openRead()) return { user: null, response: null };
    return { user: null, response: unauthorised() };
  }
  if (!atLeast(user.role, minRole)) return { user, response: forbidden(minRole) };
  return { user, response: null };
}
