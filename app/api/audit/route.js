// GET /api/audit — the audit trail (admin only).
import { listAudit } from '@/lib/db';
import { currentUser, atLeast } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'admin')) return Response.json({ error: 'admin only' }, { status: 403 });
  return Response.json({ audit: await listAudit(100) }, { headers: { 'Cache-Control': 'no-store' } });
}
