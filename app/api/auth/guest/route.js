// POST /api/auth/guest — mint a read-only session for the public trial.
//
// This is what the "View trial" button on the product site lands on. It is a
// real session for a real account with the viewer role, so the visitor sees the
// picture and nothing else: no operator write-back, no rule changes, no
// administration, no audit trail, no user list. Those are enforced server side
// by the same role checks every other user goes through, which means the access
// control story is something the visitor experiences rather than something the
// site claims.
//
// Off unless PHILOTAS_TRIAL=1, so a private deployment does not accidentally
// grow an anonymous door.

import { createUser, authenticate, startSession, setCookie } from '@/lib/auth';
import { findUserByUsername } from '@/lib/db';
import { audit } from '@/lib/audit';
import crypto from 'node:crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GUEST_USERNAME = 'trial';

export async function POST() {
  if (process.env.PHILOTAS_TRIAL !== '1') {
    return Response.json({ error: 'trial access is not enabled' }, { status: 404 });
  }

  // One shared guest account. Its password is random per deployment and never
  // leaves this process: the account is only ever reachable through this route,
  // so there is nothing to leak and nothing to guess.
  let account = await findUserByUsername(GUEST_USERNAME);
  if (!account) {
    const password = crypto.randomBytes(32).toString('hex');
    // UNGUARDED ON PURPOSE, and the hazard has a name. This route is reachable
    // without a session, and everything createUser touches goes through
    // lib/db.js: an unreachable datastore throws a message carrying the host and
    // port of DATABASE_URL, and a refused INSERT throws one naming a constraint.
    // Nothing serialises either today — the rejection escapes the handler and
    // Next answers with its own opaque 500. A catch that reported what went wrong
    // is exactly how that message would reach an anonymous caller, which is the
    // defect commit 33efe18 removed from the registration route. If this ever
    // needs handling, read the brand (lib/errors.js) and forward nothing else.
    // Two visitors arriving together is the ordinary case here, and createUser
    // now answers that lost race with its own message rather than the driver's.
    await createUser(GUEST_USERNAME, password, { role: 'viewer', clearance: 0 });
    account = await findUserByUsername(GUEST_USERNAME);
    await audit('system', 'trial.provision', 'created the viewer-role trial account');
  }

  // Guard against a deployment where the account predates this route and was
  // created with a stronger role. A trial session must never exceed viewer.
  if (account.role !== 'viewer' || (account.clearance ?? 0) !== 0) {
    return Response.json(
      { error: 'trial account is misconfigured; expected viewer role at UNCLASSIFIED' },
      { status: 500 }
    );
  }

  const token = await startSession(account.id);
  await audit(GUEST_USERNAME, 'trial.session', '');

  return new Response(
    JSON.stringify({ user: { username: GUEST_USERNAME, role: 'viewer', clearance: 0 }, trial: true }),
    { status: 200, headers: { 'content-type': 'application/json', 'Set-Cookie': setCookie(token) } }
  );
}
