// /api/workflows — detection-workflow CRUD.
//   GET    list workflows (built-ins + stored) with their latest run
//   POST   create a workflow (operator)
//   PATCH  { id, enabled } toggle (operator)
//   DELETE ?id= remove a stored workflow (operator; built-ins are restored)
import crypto from 'node:crypto';
import { allWorkflows, workflowSummary } from '@/lib/workflows';
import { addWorkflow, deleteWorkflow, updateWorkflow, latestWorkflowRun } from '@/lib/db';
import { currentUser, atLeast } from '@/lib/auth';
import { requireUser } from '@/lib/guard';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function withRuns(workflows) {
  return Promise.all(workflows.map(async (w) => {
    const last = await latestWorkflowRun(w.id).catch(() => null);
    return {
      ...w,
      summary: workflowSummary(w),
      lastRun: last ? { firedAt: last.firedAt, count: last.detail?.count, coord: last.detail?.coord, label: last.detail?.label } : null,
    };
  }));
}

export async function GET(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;
  const workflows = await withRuns(await allWorkflows());
  return Response.json({ workflows });
}

export async function POST(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const { name, region, trigger, actions, cooldownMs } = body;
  const classes = (trigger?.classes || []).filter((c) => typeof c === 'string' && c.trim());
  if (!name || !classes.length) return Response.json({ error: 'name and trigger.classes are required' }, { status: 400 });
  const workflow = {
    id: crypto.randomUUID(),
    name: String(name).slice(0, 120),
    enabled: true,
    created_ms: Date.now(),
    region: region || '*',
    trigger: {
      classes,
      minScore: Number(trigger?.minScore) || 0.4,
      withinMs: Math.min(60 * 60_000, Math.max(60_000, Number(trigger?.withinMs) || 5 * 60_000)),
      minDetections: Math.max(1, Number(trigger?.minDetections) || 1),
    },
    actions: Array.isArray(actions) ? actions.filter((a) => a && a.type) : [{ type: 'alert', priority: 'high' }],
    cooldownMs: Math.min(60 * 60_000, Math.max(60_000, Number(cooldownMs) || 10 * 60_000)),
  };
  await addWorkflow(workflow);
  await audit(user.username, 'workflow.add', workflow.name);
  return Response.json({ workflow });
}

export async function PATCH(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });
  const { id, enabled } = await req.json().catch(() => ({}));
  if (!id || typeof enabled !== 'boolean') return Response.json({ error: 'id and enabled are required' }, { status: 400 });
  const workflows = await allWorkflows();
  const existing = workflows.find((w) => w.id === id);
  if (!existing) return Response.json({ error: 'workflow not found' }, { status: 404 });
  let result;
  if (existing.builtin) {
    // Override the built-in with a stored copy carrying the new flag.
    result = await addWorkflow({ ...existing, enabled });
  } else {
    result = await updateWorkflow(id, { enabled });
  }
  await audit(user.username, 'workflow.' + (enabled ? 'enable' : 'disable'), existing.name);
  return Response.json({ workflow: result || existing });
}

export async function DELETE(req) {
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
  // Deleting a built-in id removes any stored override, restoring the default.
  const ok = await deleteWorkflow(id);
  if (ok) await audit(user.username, 'workflow.delete', id);
  return Response.json({ ok });
}