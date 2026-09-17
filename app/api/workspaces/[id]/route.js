// GET    /api/workspaces/<id>  — full workspace (if mine or shared)
// DELETE /api/workspaces/<id>  — delete (if mine)
import { getWorkspace, deleteWorkspace } from '@/lib/db';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req, { params }) {
  const { id } = await params;
  const user = await currentUser(req);
  const ws = await getWorkspace(id);
  if (!ws) return Response.json({ error: 'not found' }, { status: 404 });

  const mine = !!user && ws.ownerId === user.id;
  const cleared = (user?.clearance ?? 0) >= (ws.classification ?? 0);
  const allocated = (ws.sharedWith || []).includes(user?.username);
  const visible = mine || (cleared && (ws.visibility === 'shared' || allocated));
  if (!visible) return Response.json({ error: 'forbidden' }, { status: 403 });

  return Response.json({ id: ws.id, name: ws.name, data: ws.data, visibility: ws.visibility, classification: ws.classification ?? 0, mine });
}

export async function DELETE(req, { params }) {
  const { id } = await params;
  const user = await currentUser(req);
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });
  const ok = await deleteWorkspace(id, user.id);
  return Response.json({ ok });
}
