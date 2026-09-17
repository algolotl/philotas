// test/corpus-search-integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { applySemanticSchema, _resetApplied } from '../lib/schema/apply.js';
import { searchChunks } from '../lib/corpus/search.js';
import { embed } from '../lib/embed.js';

// Runs only where a database and an embedder are reachable. Skipped otherwise
// rather than failing, so the suite stays green on a laptop.
const HAVE_DB = !!process.env.DATABASE_URL;

let pool;
const CASE_A = `test-a-${Date.now()}`;
const CASE_B = `test-b-${Date.now()}`;

const BERTH_TEXT = 'The vessel OOCL SHANGHAI berthed at Brotherson Dock 10 in Port Botany.';

// An embed_model identity the embedder does not report, written against a vector
// that IS the right number of dimensions. That combination is the dangerous one:
// Postgres accepts the insert, cosine distance computes without complaint, and
// the neighbours it returns come from a different space. Two 1024-dimension
// models in one column is not hypothetical — it is what happens when a
// deployment changes embedder and re-embeds part of a corpus.
//
// Deliberately the SAME SERVICE and a different model. The old bait
// (`retired_embedder_1024`) differed in its service half too, so it was excluded
// by a predicate that only ever compared services — it could not distinguish the
// fix from what preceded it. This one is the case the composed identifier exists
// for: an in-place embedder upgrade on the same role and port, where the service
// string is identical and only the model moved.
const FOREIGN_EMBED_MODEL = 'bge_8005:e5-large-v2';

// A query with no lexeme in common with any fixture text, so the lexical leg
// contributes nothing and what reaches the caller came from the dense leg alone.
// Without that, the foreign-space chunk would arrive through full-text search —
// correctly, since lexical retrieval compares no vectors — and the dense-leg
// exclusion below could not be observed.
const DENSE_ONLY_QUERY = 'hydrographic telemetry cadence anomaly';

before(async () => {
  if (!HAVE_DB) return;
  const pg = (await import('pg')).default;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  _resetApplied();
  await applySemanticSchema(pool);

  const docs = [
    [CASE_A, 'a-doc', 0, BERTH_TEXT, null],
    [CASE_B, 'b-doc', 0, BERTH_TEXT, null],
    [CASE_A, 'a-doc2', 3, 'Classified: the same vessel, at a higher clearance.', null],
    // The bait for the embedding-space test. Same case, same clearance, same
    // text byte for byte, and — because it is embedded by the same call — the
    // same vector as a-doc-0. Its ONLY difference is the embed_model recorded
    // against it, so its absence from a search cannot come from a text
    // difference, a scope difference or a worse distance. Its id keeps the
    // `a-doc` prefix the case-isolation test below uses as a case-membership
    // proxy, because it IS in case A.
    [CASE_A, 'a-doc-foreign', 0, BERTH_TEXT, FOREIGN_EMBED_MODEL],
  ];
  for (const [caseId, docId, clearance, text, foreignEmbedModel] of docs) {
    await pool.query(
      `INSERT INTO documents (id, case_id, filename, mime, sha256, uploaded_by, uploaded_ms, clearance)
       VALUES ($1,$2,$3,'text/plain',$4,'test',$5,$6) ON CONFLICT DO NOTHING`,
      [docId, caseId, `${docId}.txt`, `sha-${docId}`, Date.now(), clearance]
    );
    // `embedModel`, the composed `service:model`. This fixture once destructured
    // `model` from a function that returned neither — so every chunk was written
    // with embed_model NULL, and once lib/corpus/search.js pinned embed_model
    // that would have excluded the whole fixture and made both isolation tests
    // below pass on an empty result.
    const { vectors, embedModel } = await embed([text]);
    await pool.query(
      `INSERT INTO chunks (id, doc_id, case_id, clearance, ord, content, embedding, embed_model, token_count, created_ms)
       VALUES ($1,$2,$3,$4,0,$5,$6::vector,$7,10,$8) ON CONFLICT DO NOTHING`,
      [
        `${docId}-0`,
        docId,
        caseId,
        clearance,
        text,
        `[${vectors[0].join(',')}]`,
        foreignEmbedModel ?? embedModel,
        Date.now(),
      ]
    );
  }
});

after(async () => {
  if (!HAVE_DB || !pool) return;
  await pool.query('DELETE FROM documents WHERE case_id = ANY($1)', [[CASE_A, CASE_B]]);
  await pool.end();
});

test('a chunk from another case never surfaces, however well it matches', async (t) => {
  if (!HAVE_DB) return t.skip('DATABASE_URL not set');
  const { hits } = await searchChunks(pool, {
    query: 'OOCL SHANGHAI berthed at Brotherson Dock',
    caseIds: [CASE_A],
    clearance: 3,
    limit: 10,
  });
  assert.ok(hits.length > 0, 'the in-scope chunk is found');
  for (const h of hits) {
    assert.ok(h.id.startsWith('a-doc'), `chunk ${h.id} is outside case ${CASE_A}`);
  }
});

test('clearance is a ceiling, not a filter applied afterwards', async (t) => {
  if (!HAVE_DB) return t.skip('DATABASE_URL not set');
  const { hits } = await searchChunks(pool, {
    query: 'the same vessel at a higher clearance',
    caseIds: [CASE_A],
    clearance: 0,
    limit: 10,
  });
  assert.ok(
    hits.length > 0,
    'the clearance-0 chunk is retrievable, so an empty result would mean this test proved nothing'
  );
  for (const h of hits) {
    assert.notEqual(h.id, 'a-doc2-0', 'a clearance-3 chunk must not reach a clearance-0 session');
  }
});

test('the fixture records the service AND model that produced each vector', async (t) => {
  if (!HAVE_DB) return t.skip('DATABASE_URL not set');
  // This file wrote embed_model NULL for two months, because it destructured a
  // key the function does not return. Nothing noticed, because nothing read the
  // column. Now that the dense leg pins it, a NULL here would exclude every
  // fixture chunk and turn both isolation tests above into assertions over an
  // empty list. This is the check that stops that being silent.
  const { embedModel } = await embed(['probe']);
  // Against the live server, so this is the one place the FORMAT is checked
  // end to end rather than against a stub.
  assert.match(embedModel, /^bge_8005:.+/, 'embed_model is service:model, not a service alone');
  // Scoped by case_id as well as by id: the case ids are run-unique
  // (`test-a-${Date.now()}`) but document and chunk ids are not, so rows left
  // behind by a crashed earlier run would otherwise be selected here.
  const { rows } = await pool.query(
    'SELECT id, embed_model FROM chunks WHERE case_id = ANY($1) AND id = ANY($2) ORDER BY id',
    [[CASE_A, CASE_B], ['a-doc-0', 'a-doc2-0', 'b-doc-0']]
  );
  assert.equal(rows.length, 3, 'all three ordinary fixture chunks are present');
  for (const row of rows) {
    assert.equal(row.embed_model, embedModel, `chunk ${row.id} records the service and model that embedded it`);
  }
});

test('a chunk from a foreign embedding space never reaches the dense leg, however close its vector', async (t) => {
  if (!HAVE_DB) return t.skip('DATABASE_URL not set');

  const { vectors } = await embed([DENSE_ONLY_QUERY]);
  const queryVector = `[${vectors[0].join(',')}]`;

  // The bait and the chunk it shadows differ by embed_model and by nothing else,
  // asserted from the database rather than from the fixture literal, so a later
  // edit cannot quietly turn the exclusion below into a text difference. The
  // distance is compared in SQL rather than by reading the vector column back,
  // because it is the distance — not the column's client-side representation —
  // that decides what the dense leg returns.
  const { rows: pair } = await pool.query(
    `SELECT id, content, embed_model, embedding <=> $3::vector AS distance
       FROM chunks WHERE case_id = ANY($1) AND id = ANY($2) ORDER BY id`,
    [[CASE_A], ['a-doc-0', 'a-doc-foreign-0'], queryVector]
  );
  assert.equal(pair.length, 2, 'both the included chunk and the bait are present');
  const [included, bait] = pair;
  assert.equal(included.id, 'a-doc-0');
  assert.equal(bait.id, 'a-doc-foreign-0');
  assert.equal(bait.content, included.content, 'byte-identical text, so an absence cannot be a text difference');
  assert.equal(
    Number(bait.distance),
    Number(included.distance),
    'identical distance to the query, so an absence cannot be a worse ranking'
  );
  assert.notEqual(bait.embed_model, included.embed_model, 'the embedding space is the only difference');

  // Non-vacuity: the same dense ordering WITHOUT the embed_model predicate hands
  // the bait back. Its absence below is therefore the predicate working, not a
  // fixture that was never retrievable — the discipline test/corpus-scope.test.js
  // uses for case ownership.
  const { rows: unpinned } = await pool.query(
    `SELECT id FROM chunks
      WHERE case_id = ANY($1) AND clearance <= $2 AND embedding IS NOT NULL
      ORDER BY embedding <=> $3::vector
      LIMIT 50`,
    [[CASE_A], 0, queryVector]
  );
  assert.ok(
    unpinned.some((r) => r.id === 'a-doc-foreign-0'),
    'the bait must be retrievable without the predicate, or this test proves nothing'
  );

  // The lexical leg is asserted empty AT SOURCE, not only in the hits. The loop
  // below inspects hits after rerank, so a lexical contribution could in general
  // be truncated away before the loop ever sees it; that loop is sound here only
  // because case A at clearance 0 holds two chunks, both well inside rerank's
  // topN of 10. That is a property of this fixture rather than of the test, and a
  // larger fixture would break the isolation silently. This query does not depend
  // on the fixture's size.
  const { rows: lexicalRows } = await pool.query(
    `SELECT id FROM chunks
      WHERE case_id = ANY($1) AND clearance <= $2
        AND content_tsv @@ plainto_tsquery('english', $3)`,
    [[CASE_A], 0, DENSE_ONLY_QUERY]
  );
  assert.deepEqual(
    lexicalRows,
    [],
    'DENSE_ONLY_QUERY shares no lexeme with any fixture text, so the lexical leg contributes nothing and the exclusion below can only be the dense predicate'
  );

  const { hits, mixedEmbedModelExcluded } = await searchChunks(pool, {
    query: DENSE_ONLY_QUERY,
    caseIds: [CASE_A],
    clearance: 0,
    limit: 10,
  });

  // Everything that arrived came from the dense leg. If the lexical leg had
  // contributed, the bait could be absent for a reason that has nothing to do
  // with embedding spaces and this test would be measuring the wrong predicate.
  for (const h of hits) {
    assert.equal(h.lexical_rank, null, `hit ${h.id} came from full-text search, so this run does not isolate the dense leg`);
  }
  assert.ok(hits.some((h) => h.id === 'a-doc-0'), 'the current-space chunk is returned, so the predicate did not exclude everything');
  assert.ok(!hits.some((h) => h.id === 'a-doc-foreign-0'), 'a chunk from another embedding space is not a neighbour, it is a wrong answer');
  assert.equal(
    mixedEmbedModelExcluded,
    1,
    'exactly the bait was held back, and the count says so rather than leaving the caller to infer it from a short result'
  );
});
