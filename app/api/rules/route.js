// GET    /api/rules        — built-in + user rules
// POST   /api/rules        — add a user rule
// DELETE /api/rules?id=    — delete a user rule
import crypto from 'node:crypto';
import { allRules, DEFAULT_RULES } from '@/lib/rules';
import { addRule, deleteRule } from '@/lib/db';
import { currentUser, atLeast } from '@/lib/auth';
import { requireUser } from '@/lib/guard';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const OPS = new Set(['gte', 'lte', 'eq', 'contains', 'in']);

export async function GET(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  return Response.json({ rules: await allRules() });
}

export async function POST(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });
  const { name, layer, field, op, value } = await req.json().catch(() => ({}));
  if (!name || !layer || !field || !OPS.has(op)) {
    return Response.json({ error: 'name, layer, field and a valid op are required' }, { status: 400 });
  }
  const rule = { id: crypto.randomUUID(), name, layer, field, op, value, enabled: true };
  await addRule(rule);
  await audit(user.username, 'rule.add', name);
  return Response.json({ rule });
}

export async function DELETE(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });
  const id = new URL(req.url).searchParams.get('id');
  if (DEFAULT_RULES.some((r) => r.id === id)) return Response.json({ error: 'cannot delete a built-in rule' }, { status: 400 });
  const ok = await deleteRule(id);
  if (ok) await audit(user.username, 'rule.delete', id);
  return Response.json({ ok });
}
