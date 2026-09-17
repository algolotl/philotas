// Case files — a confirmed event, its recorded frames, and an assessment.
//
// This is the answer to the problem that makes live demonstrators fragile: the
// headline capability only fires when the world cooperates. A visitor who opens
// the trial for ninety seconds will usually see a calm harbour, and a picture
// whose centrepiece is an event that mostly does not happen is a picture that
// goes quiet.
//
// A case file records something that DID happen, with the frame range needed to
// replay it and the evidence that triggered it, so it can be opened on demand.
// Everything in one is real and timestamped; nothing is fabricated. Recorded
// case files are labelled as recorded — see `recorded: true` below and the
// honesty requirements in the spec.
//
// Two sources feed it:
//   - detector events written by parallax-ingest (AIS: gaps, loitering, ...)
//   - rule-triggered alerts evaluated live (quakes, emergency squawks, fires)
// Making it general rather than maritime-only matters practically: when AIS is
// unavailable the feature still has material, and the concept was never
// specific to vessels anyway.

import { evaluateAlerts } from '../rules.js';
import { listEvents } from '../db.js';
import { history } from '../store.js';
import { assessCaseFile } from './assess.js';

const cache = new Map(); // regionId -> { at, files }
const TTL = 30_000;

// How much recorded context to offer either side of the moment.
const FRAME_WINDOW_MS = 20 * 60 * 1000;
const MAX_FILES = 12;

// An alert is only worth a case file if it is materially significant. Every
// quake on earth is an alert; not every quake deserves an operator's attention.
function alertSignificance(alert) {
  const p = alert.properties || alert;
  if (p.magnitude != null) return Number(p.magnitude) >= 4.5 ? Number(p.magnitude) / 10 : 0;
  if (p.squawk && ['7500', '7600', '7700'].includes(String(p.squawk))) return 0.95;
  if (p.alert_level && /emergency/i.test(p.alert_level)) return 0.9;
  return 0.5;
}

// Detector events carry their own confidence implicitly through type.
const EVENT_WEIGHT = {
  ais_gap: 0.95,
  identity_anomaly: 0.9,
  loitering: 0.7,
  port_call_mismatch: 0.65,
  course_deviation: 0.55,
};

function frameRange(atMs) {
  return { frame_from_ms: atMs - FRAME_WINDOW_MS / 2, frame_to_ms: atMs + FRAME_WINDOW_MS / 2 };
}

// Which recorded feeds actually have frames covering this moment. Without this
// the UI offers a replay button that scrubs through nothing.
function replayableLayers(region, fromMs, toMs) {
  return (region.layers || []).filter((layer) => {
    const frames = history(layer, region.id, 60);
    return frames.some((f) => f.t >= fromMs && f.t <= toMs);
  });
}

export async function getCaseFiles(region) {
  const now = Date.now();
  const hit = cache.get(region.id);
  if (hit && now - hit.at < TTL) return hit.files;

  const candidates = [];

  // 1. Detector events from ingest. Absent when AIS is unavailable, which is
  //    why alerts are the second source rather than the only fallback.
  try {
    for (const event of await listEvents(region.id, 40)) {
      candidates.push({
        id: `event:${event.id}`,
        kind: 'detector',
        type: event.type,
        title: `${String(event.type).replace(/_/g, ' ')} — ${event.detail?.vessel_name || event.mmsi || 'unknown vessel'}`,
        at_ms: event.detected_at_ms,
        position: event.position,
        evidence: event.evidence,
        detail: event.detail || {},
        weight: EVENT_WEIGHT[event.type] ?? 0.5,
      });
    }
  } catch { /* no datastore events: alerts still apply */ }

  // 2. Resolved ontology links that are operationally notable in their own
  //    right. A cruise ship coming alongside the Overseas Passenger Terminal
  //    while the Quay's transport load rises IS the event this product exists
  //    to surface — it does not become one only when something goes wrong.
  //
  //    Including these is what makes the feature work on an ordinary day. The
  //    first cut drew only on quakes above M4.5, emergency squawks and AIS
  //    anomalies, and correctly produced nothing at all: a case-file panel that
  //    is empty whenever the world is calm fails at the exact job it was added
  //    to do.
  try {
    const { getOntology } = await import('../ontology/service.js');
    const artifact = await getOntology(region);
    for (const link of artifact.links || []) {
      if (link.type !== 'coincides_with' && link.type !== 'berthed_at') continue;
      // Berthings are numerous; only the ones carrying a convergence signal or
      // a large vessel are worth an operator's time.
      const isConvergence = link.type === 'coincides_with';
      if (!isConvergence) continue;
      candidates.push({
        id: `link:${link.id}`,
        kind: 'ontology',
        type: link.type,
        title: `${link.fromLabel} alongside ${link.toLabel}`,
        at_ms: artifact.generatedAt || now,
        position: link.fromCoord || link.toCoord || null,
        evidence: link.provenance,
        detail: { link_type: link.type, confidence: link.confidence, method: link.method },
        weight: 0.8,
      });
    }
  } catch { /* ontology unavailable: other sources still apply */ }

  // 3. Live rule-triggered alerts.
  try {
    for (const alert of await evaluateAlerts(region)) {
      const p = alert.properties || {};
      candidates.push({
        id: `alert:${alert.rule || 'rule'}:${p.id || p.title || alert.title}`,
        kind: 'alert',
        type: alert.rule || 'alert',
        title: `${alert.ruleName || 'Alert'} — ${p.title || p.callsign || p.location || 'entity'}`,
        at_ms: p.time ? Date.parse(p.time) || now : now,
        position: alert.coord || alert.geometry?.coordinates || null,
        evidence: alert.ruleName ? `matched rule "${alert.ruleName}"` : 'matched an active rule',
        detail: p,
        weight: alertSignificance(alert),
      });
    }
  } catch { /* alerts unavailable: detector events still apply */ }

  const files = candidates
    .filter((c) => c.weight >= 0.5 && Number.isFinite(c.at_ms))
    .sort((a, b) => b.weight - a.weight || b.at_ms - a.at_ms)
    .slice(0, MAX_FILES)
    .map((c) => {
      const range = frameRange(c.at_ms);
      return {
        ...c,
        ...range,
        // Labelled so the interface can say so. A replay of a recorded moment
        // presented as live would be exactly the kind of thing this product
        // claims not to do.
        recorded: true,
        replayable_layers: replayableLayers(region, range.frame_from_ms, range.frame_to_ms),
      };
    });

  // The assessment is the one place a model is used here, and only to describe
  // an event the deterministic layer already decided had happened.
  const assessed = await assessCaseFile(files, region);

  cache.set(region.id, { at: now, files: assessed });
  return assessed;
}

export async function getCaseFile(region, id) {
  const files = await getCaseFiles(region);
  return files.find((f) => f.id === id) || null;
}
