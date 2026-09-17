// POST /api/auth/register { username, password }
import { createUser, startSession, setCookie } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { isDisclosable } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req) {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password || String(password).length < 4) {
    return Response.json({ error: 'username and a password of at least 4 characters are required' }, { status: 400 });
  }
  try {
    const user = await createUser(username, password);
    const token = await startSession(user.id);
    await audit(user.username, 'register', `role=${user.role} clearance=${user.clearance}`);
    return new Response(JSON.stringify({ user: { username: user.username } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'Set-Cookie': setCookie(token) },
    });
  } catch (err) {
    // THIS ROUTE IS UNAUTHENTICATED, so the catch is the whole security boundary.
    // It used to be `String(err.message || err)`, which forwarded whatever
    // createUser's datastore said: on a deployment with DATABASE_URL set, a
    // Postgres that is refusing connections makes Node throw
    // `connect ECONNREFUSED <host>:<port>` — the host and port of DATABASE_URL —
    // and a refused INSERT names a constraint, which is the schema. Neither
    // needed an account to read.
    //
    // Only messages raised deliberately go out (lib/errors.js). "username
    // already taken" is one of them and is the answer rather than a leak, so the
    // route still says it; anything that escaped from the driver, the filesystem
    // or the network is not, and cannot be marked by accident.
    if (isDisclosable(err)) return Response.json({ error: err.message }, { status: 400 });

    // The message is not dropped, it is moved: an operator reads it in the server
    // log, where the caller cannot. Logged once, as the error itself, so the
    // stack comes with it.
    console.error('[register] registration failed:', err);
    // 503, not 400. A datastore that is down is not the caller's bad request, and
    // a monitor has to be able to tell the two apart without parsing prose.
    return Response.json({ error: 'registration is temporarily unavailable' }, { status: 503 });
  }
}
