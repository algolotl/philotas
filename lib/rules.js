// Alerting rules engine. Rules are simple predicates over a layer's feature
// properties; evaluation runs against the current snapshot and returns matching
// entities as alerts. Built-in operational rules ship by default; users add more
// via /api/rules (stored in the datastore).

import { getFeed, FETCHERS } from './cache.js';
import { listRules } from './db.js';
import { LAYERS } from './layers.js';

const COLOR = Object.fromEntries(LAYERS.map((l) => [l.id, l.color]));

export const DEFAULT_RULES = [
  { id: 'def-quake', name: 'Major earthquake (M ≥ 4.5)', layer: 'seismic', field: 'magnitude', op: 'gte', value: 4.5, builtin: true },
  { id: 'def-squawk', name: 'Aircraft emergency squawk', layer: 'aviation', field: 'squawk', op: 'in', value: ['7500', '7600', '7700'], builtin: true },
  { id: 'def-fire', name: 'Emergency-level fire', layer: 'fires', field: 'alert_level', op: 'contains', value: 'Emergency', builtin: true },
];

function match(rule, p) {
  const v = p[rule.field];
  if (v == null || v === '') return false;
  switch (rule.op) {
    case 'gte': return Number(v) >= Number(rule.value);
    case 'lte': return Number(v) <= Number(rule.value);
    case 'eq': return String(v) === String(rule.value);
    case 'contains': return String(v).toLowerCase().includes(String(rule.value).toLowerCase());
    case 'in': return (rule.value || []).map(String).includes(String(v));
    default: return false;
  }
}

export async function allRules() {
  const stored = await listRules();
  return [...DEFAULT_RULES, ...stored];
}

export async function evaluateAlerts(region) {
  const rules = (await allRules()).filter((r) => r.enabled !== false && region.layers.includes(r.layer) && FETCHERS[r.layer]);
  const layers = [...new Set(rules.map((r) => r.layer))];
  const feeds = {};
  await Promise.all(layers.map(async (k) => { feeds[k] = (await getFeed(k, region)).payload; }));

  const alerts = [];
  for (const rule of rules) {
    const fc = feeds[rule.layer];
    if (!fc) continue;
    for (const f of fc.features || []) {
      const p = f.properties || {};
      if (!match(rule, p)) continue;
      const coord = f.geometry?.coordinates;
      alerts.push({
        id: `${rule.id}:${p.id || (coord ? coord.join(',') : '') || p.title || p.callsign || alerts.length}`,
        rule: rule.name, layer: rule.layer, color: COLOR[rule.layer] || '#ef4444',
        label: p.title || p.callsign || p.id || rule.layer,
        field: rule.field, value: p[rule.field], coord: f.geometry?.coordinates || null,
      });
      if (alerts.length >= 100) break;
    }
  }
  return alerts;
}
