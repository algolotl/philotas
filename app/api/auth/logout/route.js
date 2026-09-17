// POST /api/auth/logout
import { tokenFromRequest, endSession, clearCookie } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req) {
  const token = tokenFromRequest(req);
  if (token) await endSession(token);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'Set-Cookie': clearCookie() },
  });
}
