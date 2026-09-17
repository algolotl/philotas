// Entity enrichment — the retrieval half of the corpus feature.
//
// Given one live entity (a vessel, a berth, a fire incident...), ask every
// registered source for documents that might be about it, dedup and store
// what comes back, and record which entity each stored document was found
// for. This is the only place SOURCES and lib/corpus/store.js meet.
// lib/corpus/governor.js (owned elsewhere) decides WHEN to call this and
// which entities are due — not how a single entity gets enriched.

import { SOURCES } from './sources/index.js';
import { upsertDocuments, recordMentions, documentId } from './store.js';

// Entities worth spending a search on. A source search is not free — it's a
// request against a host that already 429s us — so this list exists to keep
// the background pass spending its budget where a hit is actually possible.
//
// Deliberately EXCLUDES TransportVehicle: a bus identified as "Bus 412 /
// fleet 8823" has no open-source footprint to find. Nobody writes news
// about, or files a public health alert about, a specific bus — the
// identifying label isn't even the kind of thing that would appear in
// prose. And Sydney runs about 3,600 of them through the TfNSW feed, so
// including the type wouldn't just be a few wasted searches, it would be
// the overwhelming majority of a ~250-entity pass spent on lookups that can
// only ever come back empty, starving the types that actually turn
// something up: a vessel by name, a berth or facility by place name, an
// incident by the suburb it's in.
export const SEARCHABLE_TYPES = new Set([
  'Vessel', 'Berth', 'Facility', 'FireIncident', 'Aircraft', 'GroundStation', 'Cafe', 'Earthquake',
]);

// A source search matches by name (a quoted phrase, or a substring filter —
// see the individual sources), not by reranking or alias resolution, so
// every mention this produces is classified 'exact' at a flat confidence.
// Downstream adjudication (lib/corpus/hypothesis.js) can later raise or
// lower this via recordMentions — see the ON CONFLICT DO UPDATE in
// lib/db.js's recordEntityMentions — this is just the floor a name match
// earns on its own.
const SEARCH_MATCH_METHOD = 'exact';
const SEARCH_MATCH_CONFIDENCE = 0.8;

// `sources` defaults to the real registry; a test passes a fake list so the
// dedup/error-collection logic below is exercisable without a live network
// call or a database — the two things that would otherwise make this
// function untestable in a fast unit suite.
export async function enrichEntity(entity, sources = SOURCES) {
  const documents = [];
  const source_errors = [];
  const seenUrls = new Set(); // within this call; store.js also dedups by url across calls/entities

  for (const source of sources) {
    let rawDocs;
    try {
      rawDocs = await source.search(entity);
    } catch (err) {
      // A dead or rate-limited source must not take enrichment for this
      // entity down with it — see the hard requirement this file was built
      // against. One bad source just means this entity's enrichment is
      // thinner this pass, not that the pass fails.
      source_errors.push({ source: source.id, error: String(err?.message || err) });
      continue;
    }
    for (const raw of rawDocs || []) {
      if (!raw?.url || seenUrls.has(raw.url)) continue;
      seenUrls.add(raw.url);
      documents.push(raw);
    }
  }

  await upsertDocuments(documents);

  // A mention is recorded for every document this pass found for this
  // entity, not only the ones that were newly inserted into corpus_documents
  // — a document already in the corpus because a different entity's search
  // turned it up still needs its own mention row linking it to THIS entity,
  // or entitiesSharingDocuments never sees the connection.
  const mentions = documents.map((doc) => ({
    document_id: documentId(doc.url),
    entity_key: entity.entity_key,
    entity_type: entity.entity_type,
    entity_label: entity.entity_label,
    method: SEARCH_MATCH_METHOD,
    confidence: SEARCH_MATCH_CONFIDENCE,
  }));
  await recordMentions(mentions);

  return { documents, mentions, source_errors };
}
