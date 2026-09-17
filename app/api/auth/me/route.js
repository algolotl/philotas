// GET /api/auth/me — the current user (role + clearance), or null.
import { currentUser, CLASSES } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const user = await currentUser(req);
  return Response.json({
    user: user ? { username: user.username, role: user.role, clearance: user.clearance } : null,
    classes: CLASSES,
  });
}
