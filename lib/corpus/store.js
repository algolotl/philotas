// Corpus storage — the persistence layer for OSINT enrichment documents and
// the entity mentions inside them.
//
// Sits on lib/db.js exactly the way lib/feeds/vessels.js sits on
// listVessels(): db.js owns the schema, the backend switch and the SQL; this
// file owns the shaping a caller actually wants — stable ids, defaults, the
// dedup semantics the enrichment feature depends on — and is the only thing
// lib/corpus/retrieve.js and the other corpus modules talk to. Nothing
// outside lib/corpus/ should import lib/db.js's corpus accessors directly.
//
// Postgres only. See the comment beside these accessors in lib/db.js: the
// file backend returns empty/zero for all of them, same reasoning as
// vessels — this is background write traffic a rewrite-the-whole-file
// backend cannot survive.

import crypto from 'node:crypto';
import {
  upsertCorpusDocuments,
  recordEntityMentions,
  documentsForEntity as dbDocumentsForEntity,
  entitiesSharingDocuments as dbEntitiesSharingDocuments,
  documentsById as dbDocumentsById,
  dueForEnrichment as dbDueForEnrichment,
  markEnrichmentState,
  enrichmentStateKeys as dbEnrichmentStateKeys,
} from '../db.js';

// A document's id is a hash of its url rather than a generated UUID, so that
// two callers who independently discover the same article — the ordinary
// case here, since "the same article found via three entities" is exactly
// what the entity-connections feature is looking for — collide on write
// instead of racing to create two rows for one article. sha1 is an identity
// key, not a security boundary, so collision resistance beyond "two
// different urls essentially never hash the same" doesn't matter here.
export function documentId(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

// docs: [{url,title,source,published_ms,snippet,language}]
// Returns the number of NEW documents stored. Dedup by url is free: two docs
// sharing a url hash to the same id, and the second upsert is a no-op — see
// lib/db.js's ON CONFLICT (id) DO NOTHING.
export async function upsertDocuments(docs) {
  const now = Date.now();
  const rows = (docs || [])
    .filter((d) => d && d.url)
    .map((d) => ({
      id: documentId(d.url),
      url: d.url,
      title: d.title ?? null,
      source: d.source ?? null,
      published_ms: d.published_ms ?? null,
      snippet: d.snippet ?? null,
      retrieved_ms: now,
      language: d.language ?? null,
    }));
  if (!rows.length) return 0;
  return upsertCorpusDocuments(rows);
}

// mentions: [{document_id,entity_key,entity_type,entity_label,method,confidence}]
// Idempotent on (document_id, entity_key) — see lib/db.js's ON CONFLICT.
export async function recordMentions(mentions) {
  const now = Date.now();
  const rows = (mentions || [])
    .filter((m) => m && m.document_id && m.entity_key)
    .map((m) => ({ ...m, created_ms: now }));
  if (!rows.length) return 0;
  return recordEntityMentions(rows);
}

// Newest first. A single entity's reading list.
export async function documentsForEntity(entityKey, limit = 20) {
  return dbDocumentsForEntity(entityKey, limit);
}

// THE CORE QUERY of the corpus feature. Given one entity, every OTHER entity
// that shows up in any document this one appears in, ranked by how many
// documents they share. This is what turns a pile of scraped articles into
// "these two things keep showing up together" — the retrieval half of the
// connections feature; the SQL lives in lib/db.js's entitiesSharingDocuments.
export async function entitiesSharingDocuments(entityKey, limit = 40) {
  return dbEntitiesSharingDocuments(entityKey, limit);
}

export async function documentsById(ids) {
  return dbDocumentsById(ids);
}

// Entities whose next_due_ms has passed (or was never set). What the
// background enrichment pass pulls from to decide who to search next.
export async function dueForEnrichment(limit = 25) {
  return dbDueForEnrichment(limit);
}

// Stamps "we searched this entity just now" plus the caller's own scheduling
// decision (document_count, next_due_ms — the backoff/cadence policy lives
// with the caller, not here). last_searched_ms is always "now"; there is no
// legitimate reason for a caller to backdate it, so it isn't a parameter.
export async function markEnriched(entityKey, fields) {
  return markEnrichmentState(entityKey, { ...fields, last_searched_ms: Date.now() });
}

// Every entity_key the schedule has ever touched. Lets the background pass seed
// candidates it has not reached yet instead of re-picking the first batch.
export async function enrichmentStateKeys() {
  return dbEnrichmentStateKeys();
}
