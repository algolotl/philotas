// Open-source intelligence orchestration.
//
// Ties together the three pieces that do the actual work:
//   retrieve.js    pulls documents about an entity from public sources
//   connections.js finds which entities share documents (deterministic)
//   hypothesis.js  proposes bounded explanations (model, governed)
//
// Two entry points. `runEnrichmentPass` is the background loop that keeps the
// corpus current. `getEntityIntel` assembles everything known about one entity
// for the interface.
//
// The ordering matters and is deliberate: documents and connections are always
// produced, hypotheses only if the governance step allows them. A failure in the
// speculative layer must never cost you the factual one.

import { getOntology } from '../ontology/service.js';

const intelCache = new Map(); // entityKey -> { at, intel }
const INTEL_TTL = 60_000;

// The background pass is deliberately slow. It runs against sources with rate
// limits (GDELT already returns 429 under this application's normal load), so
// throughput is not the goal — staying inside the limits while making steady
// progress is.
let passRunning = false;
let lastPassAt = 0;
const PASS_INTERVAL_MS = 60_000;
const ENTITIES_PER_PASS = 8;

// Which entities one enrichment pass works on, in order of preference: those
// already due (past next_due_ms, or never scheduled), then — when nothing is
// due because every scheduled entity sits in the future — the candidates the
// schedule has not reached at all. The second branch is the whole fix for the
// starvation bug: a naive `candidates.slice(0, limit)` here re-picks the same
// first batch forever once it has a future due time, so entities beyond the
// first ENTITIES_PER_PASS never get enriched. Working through the unscheduled
// tail first means every candidate is searched once before any repeat.
export function selectEnrichmentBatch(candidates, due, scheduledKeys, limit) {
  if (due.length > 0) return due.slice(0, limit);
  const scheduled = new Set(scheduledKeys);
  return candidates.filter((c) => !scheduled.has(c.entity_key)).slice(0, limit);
}

// Build the searchable entity list for a region from the resolved ontology.
// The ontology is already doing entity induction across every feed, so reusing
// it means the corpus automatically covers anything a new connector adds,
// without a second registry to keep in step.
export async function searchableEntities(region) {
  const { SEARCHABLE_TYPES } = await import('./retrieve.js');
  const artifact = await getOntology(region);

  const seen = new Map();
  for (const link of artifact.links || []) {
    for (const [type, label] of [[link.fromType, link.fromLabel], [link.toType, link.toLabel]]) {
      if (!type || !label || !SEARCHABLE_TYPES.has(type)) continue;
      const key = `${type}:${label}`;
      if (!seen.has(key)) seen.set(key, { entity_key: key, entity_type: type, entity_label: label });
    }
  }
  return [...seen.values()];
}

// One increment of the background pass. Called opportunistically from the intel
// route rather than on a timer, so a deployment with no traffic does not spend
// its source quota on nobody.
export async function runEnrichmentPass(region) {
  const now = Date.now();
  if (passRunning || now - lastPassAt < PASS_INTERVAL_MS) return { skipped: true };
  passRunning = true;
  lastPassAt = now;

  try {
    const { dueForEnrichment, markEnriched, enrichmentStateKeys } = await import('./store.js');
    const { enrichEntity } = await import('./retrieve.js');

    // Seed the queue from the ontology, then work whatever is due. The second
    // branch (nothing due, seed the unscheduled tail) is what keeps the pass
    // from starving every entity past the first batch — see
    // selectEnrichmentBatch above.
    const candidates = await searchableEntities(region);
    const due = await dueForEnrichment(ENTITIES_PER_PASS).catch(() => []);
    const batch = selectEnrichmentBatch(
      candidates,
      due,
      due.length === 0 ? await enrichmentStateKeys().catch(() => []) : [],
      ENTITIES_PER_PASS
    );

    let enriched = 0;
    for (const entity of batch) {
      try {
        const result = await enrichEntity(entity);
        // Entities that keep yielding nothing are backed off hard. Most things
        // on a map have no open-source footprint at all, and re-asking about
        // them forever is how a background pass eats a rate limit.
        const found = result.documents?.length ?? 0;
        const backoff = found > 0 ? 30 * 60_000 : 6 * 60 * 60_000;
        await markEnriched(entity.entity_key, {
          entity_type: entity.entity_type,
          entity_label: entity.entity_label,
          document_count: found,
          next_due_ms: Date.now() + backoff,
        });
        enriched += 1;
      } catch { /* one entity failing must not stop the pass */ }
    }
    return { enriched, considered: batch.length };
  } catch (error) {
    return { error: String(error.message || error) };
  } finally {
    passRunning = false;
  }
}

// Everything known about one entity, for the interface.
export async function getEntityIntel(region, entityKey, { entityType, entityLabel } = {}) {
  const now = Date.now();
  const hit = intelCache.get(entityKey);
  if (hit && now - hit.at < INTEL_TTL) return hit.intel;

  const intel = {
    entity_key: entityKey,
    entity_type: entityType || entityKey.split(':')[0],
    entity_label: entityLabel || entityKey.split(':').slice(1).join(':'),
    documents: [],
    connections: [],
    hypotheses: [],
    // Distinguishes "we looked and found nothing" from "we have not looked
    // yet". Those mean very different things to an analyst and the interface
    // must be able to say which.
    enriched: false,
    notice: null,
  };

  try {
    const { documentsForEntity } = await import('./store.js');
    intel.documents = await documentsForEntity(entityKey, 20);
    intel.enriched = true;
  } catch {
    intel.notice = 'Corpus unavailable — open-source enrichment needs Postgres.';
    intelCache.set(entityKey, { at: now, intel });
    return intel;
  }

  try {
    const { findConnections } = await import('./connections.js');
    intel.connections = await findConnections(entityKey, { limit: 25 });
  } catch { /* connections are optional; documents still stand */ }

  // Hypotheses last, and never allowed to cost us the factual layer above.
  if (intel.connections.length > 0 && intel.documents.length > 0) {
    try {
      const { proposeHypotheses } = await import('./hypothesis.js');
      intel.hypotheses = await proposeHypotheses({
        entities: [
          { key: entityKey, type: intel.entity_type, label: intel.entity_label },
          ...intel.connections.slice(0, 6).map((c) => ({
            key: c.entity_key, type: c.entity_type, label: c.entity_label,
          })),
        ],
        documents: intel.documents,
        region: region?.id,
      });
    } catch { /* a rejected or unavailable hypothesis simply does not appear */ }
  }

  if (intel.documents.length === 0 && !intel.notice) {
    intel.notice = 'No open-source material found for this entity yet.';
  }

  intelCache.set(entityKey, { at: now, intel });
  return intel;
}
