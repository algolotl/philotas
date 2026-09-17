import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// entitiesSharingDocuments (lib/db.js, wrapped by lib/corpus/store.js) is THE
// CORE QUERY of the corpus feature: given one entity, every other entity
// that shares a document with it, ranked by how many documents they share.
// It needs real SQL running against real Postgres — the file backend
// intentionally returns empty for every corpus accessor (see the comment
// beside them in lib/db.js, same reasoning as the maritime tables) — so
// there is no meaningful way to exercise the query itself without a
// database. Per house rule: skip cleanly with a clear message rather than
// faking one.
//
//   DATABASE_URL=postgres://user:pass@host:5432/db node --test test/corpus-store.test.js
//
// runs the real suite. It creates the corpus_* tables itself (via lib/db.js's
// pgBackend init, triggered by the first query) and scopes every fixture
// url/entity_key to a random per-run id, so repeat runs against a shared,
// persistent database don't collide with — or need to know about — a
// previous run's leftovers. An after() hook deletes its own rows afterwards.

const HAS_DB = !!process.env.DATABASE_URL;

// documentId is a pure function (sha1 of the url) — safe and worth pinning
// regardless of which backend is active, since store.js's whole dedup-by-url
// story depends on it being deterministic.
test('documentId hashes the same url to the same id every time, and different urls never collide', async () => {
  const { documentId } = await import('../lib/corpus/store.js');
  const a = documentId('https://example.com/a');
  const b = documentId('https://example.com/a');
  const c = documentId('https://example.com/b');
  assert.equal(a, b, 'this is the mechanism the "same article found via three entities is stored once" dedup relies on');
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{40}$/, 'sha1 hex digest');
});

if (!HAS_DB) {
  test('corpus store suite against a real Postgres: SKIPPED', {
    skip: 'DATABASE_URL is not set. Point it at a real Postgres connection string to run the entitiesSharingDocuments fixture suite — the file backend has no corpus implementation to test against.',
  }, () => {});

  test('without DATABASE_URL every corpus accessor degrades to empty/zero instead of throwing (file backend — see lib/db.js)', async () => {
    const store = await import('../lib/corpus/store.js');
    assert.equal(await store.upsertDocuments([{ url: 'https://example.com/x', title: 't' }]), 0);
    assert.equal(await store.recordMentions([{ document_id: 'x', entity_key: 'Vessel:X' }]), 0);
    assert.deepEqual(await store.documentsForEntity('Vessel:X'), []);
    assert.deepEqual(await store.entitiesSharingDocuments('Vessel:X'), []);
    assert.deepEqual(await store.documentsById(['x']), []);
    assert.deepEqual(await store.dueForEnrichment(), []);
    await assert.doesNotReject(store.markEnriched('Vessel:X', { document_count: 1 }));
  });
} else {
  const RUN = crypto.randomUUID().slice(0, 8);
  const docUrl = (n) => `https://example.com/corpus-test-${RUN}/doc${n}`;
  const entityA = `TestVessel:${RUN}-A`;
  const entityB = `TestVessel:${RUN}-B`;
  const entityC = `TestVessel:${RUN}-C`;
  const entityD = `TestVessel:${RUN}-D`; // shares nothing with A — must never appear in A's results

  let store;
  let docId; // url -> id

  // One before() hook, not several — node:test runs multiple top-level
  // before() hooks in a file CONCURRENTLY, not in registration order (see
  // the same note in test/db.test.js). Splitting "import" from "seed" would
  // race the seed against the import.
  before(async () => {
    store = await import('../lib/corpus/store.js');

    const docs = [1, 2, 3, 4].map((n) => ({
      url: docUrl(n), title: `Corpus test doc ${n}`, source: 'test',
      published_ms: Date.now() - n * 1000, snippet: `snippet ${n}`, language: 'en',
    }));
    await store.upsertDocuments(docs);
    docId = Object.fromEntries(docs.map((d) => [d.url, store.documentId(d.url)]));

    // Fixture: A and B share doc1+doc2 (2 documents). A and C share doc3 (1
    // document). D only appears on doc4, which A never appears in — D must
    // be invisible to entitiesSharingDocuments(A).
    await store.recordMentions([
      { document_id: docId[docUrl(1)], entity_key: entityA, entity_type: 'Vessel', entity_label: 'Vessel A', method: 'exact', confidence: 0.9 },
      { document_id: docId[docUrl(1)], entity_key: entityB, entity_type: 'Vessel', entity_label: 'Vessel B', method: 'exact', confidence: 0.9 },
      { document_id: docId[docUrl(2)], entity_key: entityA, entity_type: 'Vessel', entity_label: 'Vessel A', method: 'exact', confidence: 0.9 },
      { document_id: docId[docUrl(2)], entity_key: entityB, entity_type: 'Vessel', entity_label: 'Vessel B', method: 'exact', confidence: 0.9 },
      { document_id: docId[docUrl(3)], entity_key: entityA, entity_type: 'Vessel', entity_label: 'Vessel A', method: 'exact', confidence: 0.9 },
      { document_id: docId[docUrl(3)], entity_key: entityC, entity_type: 'Vessel', entity_label: 'Vessel C', method: 'exact', confidence: 0.9 },
      { document_id: docId[docUrl(4)], entity_key: entityD, entity_type: 'Vessel', entity_label: 'Vessel D', method: 'exact', confidence: 0.9 },
    ]);
  });

  after(async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('DELETE FROM entity_mentions WHERE entity_key LIKE $1', [`TestVessel:${RUN}-%`]);
    await pool.query('DELETE FROM corpus_documents WHERE url LIKE $1', [`https://example.com/corpus-test-${RUN}/%`]);
    await pool.query('DELETE FROM enrichment_state WHERE entity_key LIKE $1', [`TestVessel:${RUN}-%`]);
    await pool.end();
  });

  test('upsertDocuments dedups by url: re-inserting an already-stored url reports zero new rows', async () => {
    const again = await store.upsertDocuments([{ url: docUrl(1), title: 'duplicate insert' }]);
    assert.equal(again, 0, 'doc1 was already stored in before(); ON CONFLICT (id) DO NOTHING must make this a no-op');
  });

  test('entitiesSharingDocuments: B (2 shared documents) ranks above C (1 shared document)', async () => {
    const shared = await store.entitiesSharingDocuments(entityA, 10);
    const keys = shared.map((s) => s.entity_key);
    assert.ok(keys.includes(entityB) && keys.includes(entityC), 'both B and C must appear — each shares at least one document with A');
    assert.ok(keys.indexOf(entityB) < keys.indexOf(entityC), 'B shares more documents with A than C does, and must rank first');
  });

  test('entitiesSharingDocuments: shared_documents count and document_ids are exactly right, not just the ordering', async () => {
    const shared = await store.entitiesSharingDocuments(entityA, 10);
    const b = shared.find((s) => s.entity_key === entityB);
    const c = shared.find((s) => s.entity_key === entityC);
    assert.equal(b.shared_documents, 2);
    assert.deepEqual(new Set(b.document_ids), new Set([docId[docUrl(1)], docId[docUrl(2)]]));
    assert.equal(b.entity_type, 'Vessel');
    assert.equal(b.entity_label, 'Vessel B');
    assert.equal(c.shared_documents, 1);
    assert.deepEqual(c.document_ids, [docId[docUrl(3)]]);
  });

  test('entitiesSharingDocuments never returns the queried entity itself', async () => {
    const shared = await store.entitiesSharingDocuments(entityA, 10);
    assert.ok(!shared.some((s) => s.entity_key === entityA));
  });

  test('entitiesSharingDocuments excludes an entity that shares no document with the target', async () => {
    const shared = await store.entitiesSharingDocuments(entityA, 10);
    assert.ok(!shared.some((s) => s.entity_key === entityD), 'D only co-occurs on doc4, which A is never mentioned in');
  });

  test('recordMentions is idempotent on (document_id, entity_key): a later call refreshes the row instead of duplicating it', async () => {
    await store.recordMentions([
      { document_id: docId[docUrl(1)], entity_key: entityB, entity_type: 'Vessel', entity_label: 'Vessel B renamed', method: 'reranked', confidence: 0.95 },
    ]);
    const shared = await store.entitiesSharingDocuments(entityA, 10);
    const b = shared.find((s) => s.entity_key === entityB);
    assert.equal(b.entity_label, 'Vessel B renamed', 'the later mention must win on label — proves UPDATE, not a duplicate row ignored by DO NOTHING');
    assert.equal(b.shared_documents, 2, 'refreshing the label must not change which documents count as shared');
  });

  test('documentsForEntity returns newest-first', async () => {
    const docs = await store.documentsForEntity(entityA, 10);
    assert.ok(docs.length >= 3);
    for (let i = 1; i < docs.length; i++) {
      assert.ok(docs[i - 1].published_ms >= docs[i].published_ms, 'must be sorted newest first');
    }
  });

  test('documentsById returns exactly the requested documents', async () => {
    const docs = await store.documentsById([docId[docUrl(1)], docId[docUrl(3)]]);
    assert.equal(docs.length, 2);
    assert.deepEqual(new Set(docs.map((d) => d.id)), new Set([docId[docUrl(1)], docId[docUrl(3)]]));
  });

  test('markEnriched + dueForEnrichment: past due dates are due, future ones are not', async () => {
    const pastKey = `TestVessel:${RUN}-past-due`;
    const futureKey = `TestVessel:${RUN}-future-due`;
    await store.markEnriched(pastKey, { entity_type: 'Vessel', entity_label: 'Past Due', document_count: 1, next_due_ms: Date.now() - 1000 });
    await store.markEnriched(futureKey, { entity_type: 'Vessel', entity_label: 'Future Due', document_count: 1, next_due_ms: Date.now() + 60 * 60 * 1000 });
    // Wide net: dueForEnrichment orders next_due_ms ascending, and a shared
    // dev database may carry other stale-but-older due rows ahead of ours.
    const due = await store.dueForEnrichment(5000);
    const dueKeys = due.map((d) => d.entity_key);
    assert.ok(dueKeys.includes(pastKey), 'a next_due_ms in the past must be due');
    assert.ok(!dueKeys.includes(futureKey), 'a next_due_ms in the future must not be due yet');
  });
}
