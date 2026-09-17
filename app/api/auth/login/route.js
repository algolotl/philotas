// POST /api/auth/login { username, password }
import { authenticate, startSession, setCookie, loginThrottled } from '@/lib/auth';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req) {
  const { username, password } = await req.json().catch(() => ({}));

  // Throttle before hashing. Checking first means a guessing loop costs the
  // attacker a cheap 429 rather than costing us a scrypt derivation each time.
  if (loginThrottled(username)) {
    await audit(String(username || 'unknown'), 'login.throttled', '');
    return Response.json(
      { error: 'too many attempts, try again later' },
      { status: 429, headers: { 'Retry-After': '900' } }
    );
  }

  const user = await authenticate(username, password);
  if (!user) return Response.json({ error: 'invalid username or password' }, { status: 401 });

  const token = await startSession(user.id);
  await audit(user.username, 'login', '');
  return new Response(JSON.stringify({ user: { username: user.username } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'Set-Cookie': setCookie(token) },
  });
}
