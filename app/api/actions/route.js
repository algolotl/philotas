// GET  /api/actions?region=<id> — recent actions (audit trail)
// POST /api/actions             — record an action against an entity (write-back)
//
// Actions are the operational write surface: flag/task/dispatch/watch an entity.
// Each is persisted with the acting user + timestamp (audit). If ACTIONS_WEBHOOK_URL
// is set, the action is also POSTed there — real write-back to an external system
// (ticketing, dispatch, SIEM, etc.).
import crypto from 'node:crypto';
import { addAction, listActions } from '@/lib/db';
import { currentUser, atLeast } from '@/lib/auth';
import { requireUser } from '@/lib/guard';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TYPES = new Set(['flag', 'task', 'dispatch', 'watch']);

export async function GET(req) {
  // This returns who flagged, tasked or dispatched what, with their notes and
  // usernames. It was previously readable by anyone who knew the URL.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const region = new URL(req.url).searchParams.get('region');
  return Response.json({ actions: await listActions(region, 50) });
}

export async function POST(req) {
  const user = await currentUser(req);
  // Write-back is an operator capability — viewers and anonymous are read-only.
  if (!user || !atLeast(user.role, 'operator')) {
    return Response.json({ error: 'operator role required to act on entities' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const type = TYPES.has(body.type) ? body.type : 'flag';

  const action = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    user: user.username,
    type,
    region: body.region || null,
    entityType: body.entityType || null,
    entityLabel: body.entityLabel || null,
    note: body.note || null,
    coord: body.coord || null,
  };
  await addAction(action);
  await audit(user.username, 'action', `${type} ${action.entityLabel || ''}`);

  // Optional real write-back to an external system.
  const hook = process.env.ACTIONS_WEBHOOK_URL;
  if (hook) {
    fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }).catch(() => {});
  }
  return Response.json({ action });
}
