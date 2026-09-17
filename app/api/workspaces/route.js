// GET  /api/workspaces — my workspaces + ones shared to the team or allocated to
//                        me (subject to my clearance ≥ the workspace classification)
// POST /api/workspaces — create/update; stored centrally (Postgres when configured)
import { listWorkspaces, upsertWorkspace } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const user = await currentUser(req);
  const workspaces = await listWorkspaces(user);
  return Response.json({ user: user ? { username: user.username, role: user.role, clearance: user.clearance } : null, workspaces });
}

export async function POST(req) {
  const user = await currentUser(req);
  if (!user) return Response.json({ error: 'sign in to save workspaces' }, { status: 401 });

  const { id, name, data, visibility, classification, sharedWith } = await req.json().catch(() => ({}));
  if (!name) return Response.json({ error: 'name required' }, { status: 400 });
  const vis = visibility === 'shared' ? 'shared' : 'private';
  // You can't classify a workspace above your own clearance.
  const cls = Math.min(Number(classification) || 0, user.clearance ?? 0);
  const allocated = Array.isArray(sharedWith) ? sharedWith.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];

  const saved = await upsertWorkspace({ id, ownerId: user.id, name, data, visibility: vis, classification: cls, sharedWith: allocated });
  await audit(user.username, 'workspace.save', `"${name}" ${vis} class=${cls}${allocated.length ? ` →[${allocated.join(',')}]` : ''}`);
  return Response.json({ id: saved.id });
}
