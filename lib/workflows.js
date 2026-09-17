// Detection workflows: object detections -> alerts -> actions.
//
// A workflow is a small pipeline over the vision detections table:
//   trigger  { classes: [...], minScore, withinMs, minDetections }
//   actions  [ { type: 'alert' }, { type: 'webhook', url }, { type: 'action' } ]
//   cooldownMs - how long after a firing the same workflow stays quiet.
//
// When a workflow fires, a workflow_run row is written. That row IS the alert:
// /api/alerts merges active runs into the alert surface, so rule alerts and
// detection alerts share one place for the operator. The webhook and action
// steps then run as best-effort side effects.
//
// The use case this ships for: an accident at a traffic-light set. Classes
// like person/bicycle/car detected repeatedly on the region's cameras within
// a short window raise an alert and notify an external system.

import crypto from 'node:crypto';
import {
  listWorkflows, addWorkflowRun, listWorkflowRuns, latestWorkflowRun,
  updateWorkflow, listDetections, addAction,
} from './db.js';
import { audit } from './audit.js';

// Built-in workflows ship enabled and are overridable: storing a workflow
// with the same id replaces the builtin (see allWorkflows), so an operator
// can disable or retune it without a migration.
export const DEFAULT_WORKFLOWS = [
  {
    id: 'def-traffic-accident',
    name: 'Traffic light accident watch',
    builtin: true,
    enabled: true,
    created_ms: 0,
    region: '*',
    trigger: {
      classes: ['person', 'bicycle', 'motorcycle', 'car'],
      minScore: 0.4,
      withinMs: 5 * 60_000,
      minDetections: 2,
    },
    actions: [{ type: 'alert', priority: 'high' }],
    cooldownMs: 10 * 60_000,
  },
];

export async function allWorkflows() {
  const stored = await listWorkflows();
  const byId = new Map(DEFAULT_WORKFLOWS.map((w) => [w.id, w]));
  for (const s of stored) byId.set(s.id, s); // a stored copy overrides the builtin
  return [...byId.values()];
}

function regionMatches(workflow, region) {
  return workflow.region === '*' || !workflow.region || workflow.region === region;
}

export function workflowSummary(workflow) {
  const t = workflow.trigger || {};
  const classes = (t.classes || []).join(', ');
  const score = Math.round((t.minScore ?? 0.4) * 100);
  const mins = Math.round((t.withinMs ?? 5 * 60_000) / 60_000);
  const acts = (workflow.actions || []).map((a) => (a.type === 'webhook' ? 'webhook' : a.type)).join(' + ');
  return classes + ' score >= ' + score + '% · ' + (t.minDetections ?? 1) + ' in ' + mins + ' min -> ' + acts;
}

// Pure trigger decision, exported for tests: which detections satisfy the
// trigger. The window is measured from the NEWEST detection in the batch, so a
// burst straddling two scan calls still counts together.
export function matchesTrigger(trigger, detections, { now = Date.now() } = {}) {
  const t = trigger || {};
  const cls = new Set(t.classes || []);
  const within = t.withinMs ?? 5 * 60_000;
  const newest = detections.reduce((m, d) => Math.max(m, d.detected_at_ms || 0), 0);
  const matches = detections.filter((d) =>
    cls.has(d.class) && (d.score ?? 0) >= (t.minScore ?? 0) && (d.detected_at_ms || 0) >= newest - within);
  if (matches.length < (t.minDetections ?? 1)) return [];
  return matches;
}

// Evaluate every enabled workflow that covers this region against a batch of
// detections. Fires workflows whose trigger is met, subject to cooldown.
export async function evaluateWorkflows(region, detections, { now = Date.now() } = {}) {
  const workflows = (await allWorkflows()).filter((w) => w.enabled !== false && regionMatches(w, region));
  const fired = [];
  for (const workflow of workflows) {
    const matches = matchesTrigger(workflow.trigger, detections, { now });
    if (!matches.length) continue;

    const cooldown = workflow.cooldownMs ?? 10 * 60_000;
    const last = await latestWorkflowRun(workflow.id);
    if (last && now - last.firedAt < cooldown) continue;

    const classes = [...new Set(matches.map((d) => d.class))];
    const coord = matches.find((d) => d.coord)?.coord || null;
    const run = {
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      region,
      firedAt: now,
      detail: {
        workflow: workflow.name,
        label: 'Possible incident: ' + classes.join('+') + ' (' + matches.length + ' detections)',
        classes,
        count: matches.length,
        detectionIds: matches.map((d) => d.id).slice(0, 20),
        coord,
        priority: (workflow.actions || []).find((a) => a.type === 'alert')?.priority || 'high',
      },
    };
    await addWorkflowRun(run);
    // Builtin workflows live in code, not the datastore: skip the stored-row
    // update and let the run row carry lastRun for the panel.
    if (!workflow.builtin) {
      await updateWorkflow(workflow.id, { lastRun: { firedAt: now, count: matches.length, coord } }).catch(() => {});
    }
    for (const action of workflow.actions || []) await runAction(action, workflow, run, matches);
    await audit('workflow', 'workflow.fire', workflow.name + ' · ' + matches.length + ' detections').catch(() => {});
    fired.push({ workflow, run, matches });
  }
  return fired;
}

async function runAction(action, workflow, run, matches) {
  if (action.type === 'alert') return; // the run row is the alert
  const webhookUrl = action.type === 'webhook' && (action.url || process.env.WORKFLOW_WEBHOOK_URL);
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'philotas-workflow/0.1' },
        body: JSON.stringify({
          workflow: workflow.name, workflowId: workflow.id, firedAt: run.firedAt, region: run.region,
          alert: { label: run.detail.label, count: run.detail.count, classes: run.detail.classes, coord: run.detail.coord },
          detections: matches.slice(0, 50).map(({ id, class: cls, score, source, sourceId, detected_at_ms, coord }) => ({
            id, class: cls, score, source, sourceId, detected_at_ms, coord,
          })),
        }),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) {
      console.error('[workflow] webhook failed for', workflow.id, '-', String(err && err.message ? err.message : err));
    }
    return;
  }
  if (action.type === 'action') {
    // An operator-visible row in the ACTIONS audit list.
    await addAction({
      id: crypto.randomUUID(), ts: run.firedAt, user: 'workflow', type: 'workflow',
      region: run.region, entityType: workflow.name, entityLabel: run.detail.label, note: null, coord: run.detail.coord,
    }).catch(() => {});
  }
}

// Active workflow runs, shaped like rule alerts so /api/alerts can merge the
// two sources into one list. A run stays 'active' for ACTIVE_MS after firing.
export async function workflowAlerts(regionId) {
  const ACTIVE_MS = 30 * 60_000;
  const now = Date.now();
  const runs = await listWorkflowRuns({ region: regionId, limit: 30 });
  return runs
    .filter((r) => now - r.firedAt < ACTIVE_MS)
    .map((r) => ({
      id: 'wf:' + r.id,
      rule: 'workflow: ' + (r.detail?.workflow || r.workflowId),
      layer: 'detections',
      color: '#fb923c',
      label: r.detail?.label || 'detection workflow fired',
      field: 'class',
      value: r.detail?.classes || [],
      coord: r.detail?.coord || null,
      workflow: true,
      demo: !!r.detail?.demo,
    }));
}

// One pass over the region: pull the stored detection window, merge in any
// not-yet-stored extras, and evaluate. Used both by the detection routes
// (immediate feedback) and the background ticker.
export async function runWorkflowPass(region, extra = []) {
  const since = Date.now() - 15 * 60_000;
  const stored = await listDetections({ region, limit: 300, sinceMs: since });
  const known = new Set(stored.map((d) => d.id));
  const all = [...extra.filter((d) => !known.has(d.id)), ...stored];
  return evaluateWorkflows(region, all);
}

// Background ticker: every minute, evaluate each workflow over the regions it
// covers (or over every region that has recent detections, for '*' workflows).
// Started once from instrumentation.js so detection workflows fire even when
// nobody has the page open.
let engineStarted = false;
export function startWorkflowEngine({ intervalMs = 60_000 } = {}) {
  if (engineStarted) return;
  engineStarted = true;
  const tick = async () => {
    try {
      const since = Date.now() - 15 * 60_000;
      const workflows = (await allWorkflows()).filter((w) => w.enabled !== false);
      const regions = new Set();
      for (const wf of workflows) if (wf.region && wf.region !== '*') regions.add(wf.region);
      // '*' workflows follow the detections themselves.
      const recent = await listDetections({ limit: 500, sinceMs: since });
      for (const d of recent) if (d.region) regions.add(d.region);
      for (const regionId of regions) {
        const dets = await listDetections({ region: regionId, limit: 300, sinceMs: since });
        if (dets.length) await evaluateWorkflows(regionId, dets);
      }
    } catch (err) {
      console.error('[workflow] engine tick failed:', String(err && err.message ? err.message : err));
    }
  };
  tick();
  setInterval(tick, intervalMs).unref?.();
  console.log('[workflow] detection workflow engine started (' + intervalMs + 'ms ticks)');
}