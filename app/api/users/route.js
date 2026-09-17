// GET  /api/users — list users (admin only)
// POST /api/users — set a user's role + clearance (admin only)
import { listUsers, setUserRole } from '@/lib/db';
import { currentUser, atLeast, CLASSES } from '@/lib/auth';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROLES = new Set(['viewer', 'operator', 'admin']);

export async function GET(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'admin')) return Response.json({ error: 'admin only' }, { status: 403 });
  return Response.json({ users: await listUsers() });
}

export async function POST(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'admin')) return Response.json({ error: 'admin only' }, { status: 403 });
  const { id, role, clearance } = await req.json().catch(() => ({}));
  if (!id || !ROLES.has(role)) return Response.json({ error: 'id and a valid role required' }, { status: 400 });
  const clr = Math.max(0, Math.min(Number(clearance) || 0, CLASSES.length - 1));
  const ok = await setUserRole(id, role, clr);
  if (ok) await audit(user.username, 'role.change', `${id} → ${role}/${CLASSES[clr]}`);
  return Response.json({ ok });
}
