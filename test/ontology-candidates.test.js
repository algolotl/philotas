// test/ontology-candidates.test.js
//
// Which entities a chunk might be talking about: two independent generators,
// unioned and deduplicated by (chunk, entity).
//
// The two things these tests care most about are the ones that fail QUIETLY.
//
//   1. A leg that FOUND NOTHING and a leg that FAILED both return no candidates.
//      Every test below that expects an empty result also pins WHY it is empty,
//      because "the document mentions nothing we know about" and "the embedder is
//      down" are the same output otherwise — the defect Task 3 found twice in the
//      ontology route.
//   2. A merge that DOUBLE-COUNTS an entity found by both legs, or that ranks by
//      one leg's scale while pretending to rank by both. Neither shows up in a
//      fixture where every peer carries the same score, which is why the ranking
//      fixture below has five candidates with five different profiles of which
//      leg found them and how well.
//
// Every similarity assertion distinguishes `null` from `0`. A candidate the
// trigram leg found alone has no cosine at all, and a test that accepts 0 there
// passes while the ranking is wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMBED_DIM, _resetModelProbe } from '../lib/embed.js';
import {
  generateCandidates,
  PROFILE_SIMILARITY_TOP_K,
  TRIGRAM_TOP_K,
  TRIGRAM_MIN_WORD_SIMILARITY,
} from '../lib/ontology/candidates.js';

// ---------------------------------------------------------------- fixtures

// Written out as a literal rather than derived from EMBED_DIM, for the reason
// test/ontology-profiles.test.js states: a fixture built as
// Array.from({ length: EMBED_DIM }) pins the FORMULA and never the value.
const VECTOR_DIMENSIONS = 1024;
const vectorOf = (fill) => new Array(VECTOR_DIMENSIONS).fill(fill);

// The identity this deployment's embedder reports, probed on the reference deployment, 2026-08-17:
// registry service `bge_8005`, one model `bge-m3`. Written out as a literal.
const CURRENT_MODEL = 'bge_8005:bge-m3';

// A foreign embedding space whose SERVICE HALF IS IDENTICAL — the bait that can
// tell the fix from the bug. A predicate binding the registry service alone sees
// `bge_8005` on both sides and calls vectors from two different models
// comparable; both models are 1024-dimensional, so nothing else notices.
const RETIRED_MODEL_SAME_SERVICE = 'bge_8005:bge-m3-retired';

const MODELS_BODY = {
  object: 'list',
  data: [{ id: 'bge-m3', object: 'model', owned_by: 'llamacpp', meta: { n_embd: VECTOR_DIMENSIONS } }],
};

const denseRow = (key, type, label, distance) => ({ entity_key: key, entity_type: type, label, distance });
const trigramRow = (key, type, label, wordSimilarity) => ({
  entity_key: key, entity_type: type, label, word_similarity: wordSimilarity,
});

const close = (actual, expected, why) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${why} — expected ~${expected}, got ${actual}`);

const keysOf = (candidates) => candidates.map((c) => c.entityKey);

// ---------------------------------------------------------------- stubs

// Routes the model probe separately from the vectors. Answering every URL with
// the embeddings body — as the brief's fixture did — hands the model probe an
// embeddings row, whose `data[0].id` is undefined, and lib/embed.js then raises
// EmbedModelUnidentifiable, which is deliberately NOT `.unavailable` and takes
// the whole call down. That fixture could not have exercised the profile leg at
// all.
function embedderStub({ down = false, models = MODELS_BODY } = {}) {
  const calls = { models: 0, embeddings: 0, texts: [] };
  const handler = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/v1/models')) {
      calls.models += 1;
      if (down) throw new Error('connect ECONNREFUSED');
      return { ok: true, json: async () => models };
    }
    if (target.endsWith('/embeddings')) {
      const input = JSON.parse(init.body).input;
      calls.embeddings += 1;
      calls.texts.push(...input);
      if (down) throw new Error('connect ECONNREFUSED');
      return {
        ok: true,
        json: async () => ({
          model: 'bge-m3',
          data: input.map((_text, i) => ({ index: i, embedding: vectorOf(0.01) })),
        }),
      };
    }
    throw new Error(`unexpected fetch to ${target}`);
  };
  return { handler, calls };
}

// Resets the per-process model probe as well as swapping fetch. lib/embed.js
// caches the probe for the life of the process, so without the reset the first
// test here to embed anything fixes the model identity for every test after it.
const withStubbedFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  _resetModelProbe();
  try { return await fn(); } finally { globalThis.fetch = real; _resetModelProbe(); }
};

// A fetch that fails the assertion rather than the request, so "no round trip"
// is a test failure with a reason rather than a silent degradation.
const forbiddenFetch = async (url) => {
  throw new Error(`the embedder was contacted at ${url} when it should not have been`);
};

function stubPool({ dense = [], trigram = [], denseFails = false, trigramFails = false } = {}) {
  const pool = {
    seen: [],
    query: async (sql, params) => {
      pool.seen.push({ sql, params });
      if (/<=>/.test(sql)) {
        if (denseFails) throw new Error('relation "entity_profiles" does not exist');
        return { rows: dense };
      }
      if (/word_similarity/.test(sql)) {
        if (trigramFails) throw new Error('function word_similarity(text, text) does not exist');
        return { rows: trigram };
      }
      throw new Error(`candidate generation issued an unexpected query: ${sql}`);
    },
  };
  return pool;
}

const denseCall = (pool) => pool.seen.find(({ sql }) => /<=>/.test(sql));
const trigramCall = (pool) => pool.seen.find(({ sql }) => /word_similarity/.test(sql));

// Resolves a SQL fragment's placeholder to the value actually bound at that
// position. `params.includes(x)` is satisfied by the right value bound at the
// WRONG placeholder — Task 4 found exactly that mutation surviving on
// lib/corpus/search.js (`embed_model = $5` with the service still bound at $3) —
// so nothing below scans the parameter list.
function boundTo(call, pattern, what) {
  assert.ok(call, `${what}: the query was issued at all`);
  const found = call.sql.match(pattern);
  assert.ok(found, `${what} is bound to a placeholder. SQL was:\n${call.sql}`);
  const position = Number(found[1]);
  assert.ok(
    position >= 1 && position <= call.params.length,
    `${what} binds $${position} but only ${call.params.length} parameters were passed`
  );
  return call.params[position - 1];
}

// Captures the operator log line the cap emits, so the suite output stays clean
// AND so "the cap said what it dropped" is an assertion rather than an eyeball.
const withCapturedWarnings = async (fn) => {
  const real = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.warn = real;
  }
}

// ---------------------------------------------------------------- constants

test('the top-k and threshold values are the ones the spec named as assumed', () => {
  // Literals. An assertion importing the constant it checks pins the formula and
  // never the value: PROFILE_SIMILARITY_TOP_K === PROFILE_SIMILARITY_TOP_K agrees
  // with any number the constant ever takes. Nine instances of that shape have
  // been found in this repo, so every constant here is pinned as a written-out
  // number and the queries below resolve their LIMIT placeholders to the same
  // numbers independently.
  assert.equal(PROFILE_SIMILARITY_TOP_K, 20, 'spec section 5.2, **assumed**');
  assert.equal(TRIGRAM_TOP_K, 20, '**assumed**');
  assert.equal(TRIGRAM_MIN_WORD_SIMILARITY, 0.6, "pg_trgm's documented default for word similarity, **assumed** here");
  assert.equal(EMBED_DIM, VECTOR_DIMENSIONS, 'the fixture embeds at the dimension the code embeds at');
});

// ---------------------------------------------------------------- profile leg

test('the profile leg pins the embedding space by its composed identity, not by the serving endpoint', async () => {
  const pool = stubPool();
  const { handler } = embedderStub();
  await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'OOCL SHANGHAI berthed overnight' })
  );
  const dense = denseCall(pool);
  assert.ok(dense, 'the profile leg ran');

  // `bge_8005` alone is a SERVING ENDPOINT, not an embedding space: re-pointing
  // that registry service at a different 1024-dimension model is a routine
  // in-place upgrade that leaves the value unchanged, so one predicate would
  // match two spaces and cosine distance across them returns confident nonsense.
  assert.equal(boundTo(dense, /embed_model\s*=\s*\$(\d+)/, 'the embedding-space predicate'), CURRENT_MODEL);
  assert.notEqual(boundTo(dense, /embed_model\s*=\s*\$(\d+)/, 'the embedding-space predicate'), 'bge_8005',
    'the service half alone would cover two embedding spaces with one identifier');
  assert.match(dense.sql, /embedding IS NOT NULL/,
    'a profile row with no vector is not a distant neighbour, it has no position at all');

  // Exact scan, deliberately. The profile table is a few thousand rows (1,936
  // measured on the deployed Sydney instance, 2026-08-15) and lib/schema/
  // semantic.sql carries no HNSW index, because the spec measured the index at
  // 777 MB per 100,000 rows to sit unused next to a 1.9 ms exact scan.
  assert.doesNotMatch(dense.sql, /hnsw|ef_search/i, 'no approximate index over a few thousand profile rows');

  // The vector is ordered by the SAME parameter it is scored by. Two different
  // placeholders here would project one distance and sort by another, and every
  // row would still come back looking ordinary.
  const scored = boundTo(dense, /<=>\s*\$(\d+)::vector AS distance/, 'the distance projected');
  const ordered = boundTo(dense, /ORDER BY\s+embedding\s*<=>\s*\$(\d+)/i, 'the distance ordered by');
  assert.equal(scored, ordered, 'the rows are ordered by the vector they were scored against');
  assert.match(scored, /^\[.*\]$/, 'pgvector takes a bracketed literal');
  assert.equal(scored.replace(/^\[|\]$/g, '').split(',').length, VECTOR_DIMENSIONS,
    'the whole vector is bound, not a truncated one');

  // Resolved from the placeholder, and compared against a written-out 20.
  assert.equal(boundTo(dense, /LIMIT\s+\$(\d+)/i, 'the profile top-k'), 20);
});

// ---------------------------------------------------------------- trigram leg

test('the trigram leg matches labels and aliases against the chunk, with the text bound not interpolated', async () => {
  const pool = stubPool();
  const { handler } = embedderStub();
  // A chunk carrying something a string-concatenated query would execute. The
  // assertion below is that it appears in no SQL at all, which is a stronger
  // statement than "the text is somewhere in params".
  const chunkText = "the ferry COLLAROY at Balmain'; DROP TABLE entity_profiles; --";
  await withStubbedFetch(handler, () => generateCandidates(pool, { chunkId: 'c1', chunkText }));

  const trigram = trigramCall(pool);
  assert.ok(trigram, 'the trigram leg ran');
  assert.match(trigram.sql, /unnest\(aliases\)/,
    'aliases are matched too, or "IMO 9776171" in a document reaches no vessel');

  // word_similarity, NOT similarity. similarity() compares two whole strings, so
  // a 512-token chunk against a 14-character label scores near zero and this leg
  // would never fire at all. `\bsimilarity\(` cannot match inside
  // `word_similarity(` — the underscore is a word character, so there is no
  // boundary there — which is what makes this assertion discriminating.
  assert.match(trigram.sql, /word_similarity\(/, 'the label is scored against the best-matching run of words inside the chunk');
  assert.doesNotMatch(trigram.sql, /\bsimilarity\(/,
    'similarity() over a whole chunk scores near zero for every label and the leg never fires');

  assert.equal(boundTo(trigram, /word_similarity\(label,\s*\$(\d+)\)/, 'the chunk text'), chunkText);
  assert.equal(boundTo(trigram, /word_similarity\s*>=\s*\$(\d+)/, 'the word-similarity floor'), 0.6);
  assert.equal(boundTo(trigram, /LIMIT\s+\$(\d+)/i, 'the trigram top-k'), 20);
  assert.match(trigram.sql, /ORDER BY\s+word_similarity\s+DESC/i, 'the best-matching labels are the ones the limit keeps');

  for (const { sql } of pool.seen) {
    assert.ok(!sql.includes('DROP TABLE'), 'the chunk text is bound as a parameter, never interpolated into the SQL');
    assert.ok(!sql.includes('COLLAROY'), 'no part of the chunk text reaches the query string');
  }
});

// ---------------------------------------------------------------- the merge

test('one entity found by both legs is one candidate carrying both generators and both scores', async () => {
  const pool = stubPool({
    dense: [denseRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.21)],
    trigram: [trigramRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.92)],
  });
  const { handler } = embedderStub();
  const { candidates, generators, dropped, degraded } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'COLLAROY' })
  );

  assert.equal(candidates.length, 1, 'one entity, one candidate, however many legs found it');
  assert.deepEqual(candidates[0].generators, ['profile-similarity', 'trigram'],
    'both legs are recorded, in stage order, and neither is recorded twice');
  close(candidates[0].cosineSimilarity, 0.79, 'cosine similarity is 1 - the pgvector cosine distance');
  assert.equal(candidates[0].wordSimilarity, 0.92);
  assert.equal(candidates[0].chunkId, 'c1');
  assert.equal(candidates[0].entityType, 'Vessel');
  assert.equal(candidates[0].label, 'COLLAROY');

  // The per-leg counts are what makes the overlap visible: two legs each proposed
  // one row and one candidate came out, so the union deduplicated exactly one.
  // A caller reading only `candidates` cannot tell that from a trigram leg that
  // found nothing.
  assert.deepEqual(generators, { 'profile-similarity': 1, trigram: 1 });
  assert.equal(dropped, 0);
  assert.equal(degraded, null);
});

test('a candidate from one leg has no score from the other, and no score is not a zero score', async () => {
  const pool = stubPool({
    dense: [denseRow('Vessel:V-DENSE', 'Vessel', 'V-DENSE', 0.4)],
    trigram: [trigramRow('Berth:B-LEX', 'Berth', 'B-LEX', 0.9)],
  });
  const { handler } = embedderStub();
  const { candidates, generators } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })
  );
  assert.deepEqual(generators, { 'profile-similarity': 1, trigram: 1 });

  const byKey = new Map(candidates.map((c) => [c.entityKey, c]));
  const dense = byKey.get('Vessel:V-DENSE');
  const lexical = byKey.get('Berth:B-LEX');
  assert.ok(dense && lexical, 'both legs contributed their own entity');

  // `assert.equal` under node:assert/strict is strictEqual, so `undefined` fails
  // against `null` here. That matters: an ABSENT field and a NULL field are
  // different promises to a caller, and only one of them is the interface.
  assert.equal(dense.wordSimilarity, null, 'the trigram leg did not find this entity, so it has no word similarity');
  assert.notEqual(dense.wordSimilarity, 0, 'a missing score is not a zero score — 0 is a real word similarity');
  assert.ok(Object.hasOwn(dense, 'wordSimilarity'), 'the field is present and null, not missing');
  close(dense.cosineSimilarity, 0.6, 'cosine similarity is 1 - distance');
  assert.deepEqual(dense.generators, ['profile-similarity']);

  assert.equal(lexical.cosineSimilarity, null, 'the profile leg did not find this entity, so it has no cosine');
  assert.notEqual(lexical.cosineSimilarity, 0, 'a missing cosine is not a cosine of zero');
  assert.ok(Object.hasOwn(lexical, 'cosineSimilarity'));
  assert.equal(lexical.wordSimilarity, 0.9);
  assert.deepEqual(lexical.generators, ['trigram']);
});

test('the same entity twice from one leg is one candidate naming that leg once', async () => {
  // Defensive against a future profile leg that joins aliases and can return an
  // entity more than once. Without the guard the candidate reads
  // ['profile-similarity', 'profile-similarity'], which is a candidate that looks
  // corroborated by two generators and is not.
  const pool = stubPool({
    dense: [
      denseRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.2),
      denseRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.5),
    ],
  });
  const { handler } = embedderStub();
  const { candidates, generators } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].generators, ['profile-similarity']);
  assert.deepEqual(generators, { 'profile-similarity': 2, trigram: 0 },
    'the counts are rows proposed, so the leg is still visibly the source of two');
});

test('candidates rank by the better of the two scores, and being found twice is not a bonus', async () => {
  // Five candidates, five different shapes: dense-only high, dense-only low,
  // trigram-only high, both-with-cosine-better, both-with-word-better. A fixture
  // where every peer carries the same value proves nothing about ranking — the
  // mean-for-median campaign found fifteen such tests in this repo — so no two
  // scores here are equal and no leg's order matches the final order.
  //
  //   key      cosine (1 - distance)   word     best
  //   D        0.30                    —        0.30
  //   C        0.90                    0.62     0.90
  //   A        0.60                    —        0.60
  //   F        0.20                    0.97     0.97
  //   B        —                       0.95     0.95
  const pool = stubPool({
    // Deliberately NOT in score order: a merge that trusts the leg's ordering
    // instead of sorting reads identically until the scores disagree.
    dense: [
      denseRow('E:D', 'Vessel', 'D', 0.7),
      denseRow('E:C', 'Vessel', 'C', 0.1),
      denseRow('E:A', 'Vessel', 'A', 0.4),
      denseRow('E:F', 'Vessel', 'F', 0.8),
    ],
    trigram: [
      trigramRow('E:C', 'Vessel', 'C', 0.62),
      trigramRow('E:B', 'Vessel', 'B', 0.95),
      trigramRow('E:F', 'Vessel', 'F', 0.97),
    ],
  });
  const { handler } = embedderStub();
  const { candidates, generators } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })
  );

  assert.equal(candidates.length, 5, 'C and F were each found twice and are each one candidate');
  assert.deepEqual(generators, { 'profile-similarity': 4, trigram: 3 },
    'seven proposals, five candidates: the two overlaps are visible in the counts and nowhere else');

  // The order kills every plausible alternative to "the better of the two":
  // summing puts C first, cosine-only puts C first and B last, word-only swaps
  // A and D, and taking the first non-null score puts F last.
  assert.deepEqual(keysOf(candidates), ['E:F', 'E:B', 'E:C', 'E:A', 'E:D']);
  close(candidates[0].wordSimilarity, 0.97, 'F leads on its word similarity despite the worst cosine of the five');
  close(candidates[0].cosineSimilarity, 0.2, 'and its weak cosine is still reported rather than hidden');
  assert.equal(candidates[1].cosineSimilarity, null, 'B was never found by the profile leg');
  close(candidates[2].cosineSimilarity, 0.9, 'C outranks A on cosine, not on having been found by two legs');
  close(candidates[3].cosineSimilarity, 0.6);
  close(candidates[4].cosineSimilarity, 0.3);
});

test('candidates the profile leg scored below zero still rank against each other', async () => {
  // pgvector's `<=>` is cosine DISTANCE, in [0, 2], so a distance above 1 is a
  // profile pointing away from the chunk and a genuinely negative similarity.
  // Ranking a MISSING score as 0 rather than as nothing collapses every one of
  // these to the same number, and the merge silently stops ordering them at all —
  // the rows come back in whatever order the leg returned them and the output
  // looks ranked.
  const pool = stubPool({
    dense: [
      denseRow('Vessel:AWAY', 'Vessel', 'AWAY', 1.4),   // cosine -0.4
      denseRow('Vessel:LESS-AWAY', 'Vessel', 'LESS-AWAY', 1.2), // cosine -0.2
    ],
  });
  const { handler } = embedderStub();
  const { candidates } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })
  );
  assert.deepEqual(keysOf(candidates), ['Vessel:LESS-AWAY', 'Vessel:AWAY'],
    'the less-distant of two negative cosines ranks first, rather than both flooring to the same value');
  close(candidates[0].cosineSimilarity, -0.2, 'a negative cosine is reported, not clamped to zero');
  close(candidates[1].cosineSimilarity, -0.4);
});

test('a row a leg returns with no entity key becomes no candidate rather than an entity called undefined', async () => {
  // A hole in a result array, which is what an optional chain in a row loop is
  // written to survive. `.forEach` SKIPS holes, so a guard written under it can
  // never run — the defect found in lib/embed.js on 2026-08-17, where a sparse
  // vector array walked straight past the check meant to reject it.
  //
  // What this kills, stated exactly: removing the guard, which under an indexed
  // loop turns the hole into a TypeError. It does NOT distinguish an indexed loop
  // from `.forEach` here, because both reach the same two candidates once the
  // guard exists. The vector-hole test below is the one that kills `.forEach`.
  const dense = [denseRow('Vessel:A', 'Vessel', 'A', 0.2)];
  dense[2] = denseRow('Vessel:C', 'Vessel', 'C', 0.3);
  assert.equal(dense.length, 3, 'the fixture really is sparse');
  assert.ok(!(1 in dense), 'position 1 is a hole, not an undefined value');

  const pool = stubPool({ dense });
  const { handler } = embedderStub();
  const { candidates, generators } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })
  );
  assert.deepEqual(keysOf(candidates), ['Vessel:A', 'Vessel:C']);
  assert.deepEqual(generators, { 'profile-similarity': 2, trigram: 0 },
    'the hole proposed nothing and is counted as nothing');
  for (const candidate of candidates) {
    assert.ok(candidate.entityKey, 'no candidate keyed on undefined, which would collide with every other such row');
  }
});

// ---------------------------------------------------------------- the cap

test('by default nothing is capped, because the spec removed the silent slice(0, 40)', async () => {
  const dense = Array.from({ length: 25 }, (_, i) => denseRow(`Vessel:V${i}`, 'Vessel', `V${i}`, 0.5));
  const pool = stubPool({ dense });
  const { handler } = embedderStub();
  const { result, lines } = await withCapturedWarnings(() =>
    withStubbedFetch(handler, () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' }))
  );
  assert.equal(result.candidates.length, 25);
  assert.equal(result.dropped, 0);
  assert.deepEqual(lines, [], 'nothing was dropped, so nothing is logged');
});

test('an applied cap keeps the best-scoring candidates and reports how many it dropped', async () => {
  // Scrambled, so that "truncate before ranking" and "rank before truncating"
  // produce different sets. Rows arriving already in score order — as the brief's
  // fixture had them — make those two indistinguishable, and the wrong one keeps
  // whichever candidates the leg happened to return first.
  const order = [17, 3, 22, 9, 0, 14, 6, 24, 11, 1, 19, 8, 23, 5, 12, 2, 20, 15, 7, 21, 4, 18, 10, 16, 13];
  const dense = order.map((i) => denseRow(`Vessel:V${i}`, 'Vessel', `V${i}`, i / 100));
  const pool = stubPool({ dense });
  const { handler } = embedderStub();
  const { result, lines } = await withCapturedWarnings(() =>
    withStubbedFetch(handler, () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', cap: 10 }))
  );

  assert.equal(result.candidates.length, 10);
  assert.equal(result.dropped, 15, 'a cap that drops work silently reads as "there was nothing more to link"');
  assert.deepEqual(
    keysOf(result.candidates),
    Array.from({ length: 10 }, (_, i) => `Vessel:V${i}`),
    'the survivors are the ten best-scoring, not the first ten the leg returned'
  );
  assert.deepEqual(result.generators, { 'profile-similarity': 25, trigram: 0 },
    'the generator counts are what the legs proposed, before the cap took a slice out of it');

  assert.equal(lines.length, 1, 'the cap emits exactly one operator line');
  assert.match(lines[0], /dropped 15 of 25/, 'the log names how many went and out of how many');
  assert.match(lines[0], /c1/, 'and which chunk it happened to');
});

test('the cap boundary: exactly the cap drops nothing, one over drops one, and a cap of zero is not no cap', async () => {
  const dense = Array.from({ length: 5 }, (_, i) => denseRow(`Vessel:V${i}`, 'Vessel', `V${i}`, i / 100));
  const cases = [
    { cap: 5, kept: 5, dropped: 0, logged: 0 },
    { cap: 4, kept: 4, dropped: 1, logged: 1 },
    // The falsy trap. `if (cap && ranked.length > cap)` skips a cap of 0 entirely
    // and returns all five as though no cap had been asked for.
    { cap: 0, kept: 0, dropped: 5, logged: 1 },
  ];
  for (const { cap, kept, dropped, logged } of cases) {
    const pool = stubPool({ dense });
    const { handler } = embedderStub();
    const { result, lines } = await withCapturedWarnings(() =>
      withStubbedFetch(handler, () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', cap }))
    );
    assert.equal(result.candidates.length, kept, `cap ${cap} keeps ${kept}`);
    assert.equal(result.dropped, dropped, `cap ${cap} reports ${dropped} dropped`);
    assert.equal(lines.length, logged, `cap ${cap} logs ${logged} line(s)`);
  }

  // And a cap larger than the population is not a drop either.
  const pool = stubPool({ dense });
  const { handler } = embedderStub();
  const spare = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', cap: 99 })
  );
  assert.equal(spare.candidates.length, 5);
  assert.equal(spare.dropped, 0);
});

// ---------------------------------------------------------------- degradation

test('an unreachable embedder degrades to the trigram leg by name', async () => {
  const pool = stubPool({ trigram: [trigramRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.9)] });
  const { handler } = embedderStub({ down: true });
  const { candidates, generators, degraded } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'COLLAROY' })
  );

  assert.equal(degraded, 'no-profile-similarity');
  assert.equal(typeof degraded, 'string',
    'a boolean would tell an operator that something failed and never which stage');
  assert.equal(candidates.length, 1, 'the lexical leg still generates candidates');
  assert.equal(candidates[0].cosineSimilarity, null, 'and does not invent a cosine for them');
  assert.deepEqual(generators, { 'profile-similarity': 0, trigram: 1 },
    'zero from the failed leg, and `degraded` is the only thing that says it failed rather than found nothing');
  assert.equal(denseCall(pool), undefined, 'no query was issued with a vector nobody could produce');
});

test('an empty result says whether it is empty because nothing matched or because both legs are gone', async () => {
  // The pair is the whole point. These two calls return the same candidates and
  // the same counters, and a caller that reads only those cannot tell "this
  // document mentions nothing we know about" from "we could not look".
  const healthy = stubPool();
  const { handler } = embedderStub();
  const found = await withStubbedFetch(handler, () =>
    generateCandidates(healthy, { chunkId: 'c1', chunkText: 'nothing here resembles a known entity' })
  );
  assert.deepEqual(found, {
    candidates: [], generators: { 'profile-similarity': 0, trigram: 0 }, dropped: 0, degraded: null,
  });
  assert.ok(denseCall(healthy) && trigramCall(healthy), 'both legs really did run and really did find nothing');

  const broken = stubPool({ trigramFails: true });
  const { handler: down } = embedderStub({ down: true });
  const failed = await withStubbedFetch(down, () =>
    generateCandidates(broken, { chunkId: 'c1', chunkText: 'nothing here resembles a known entity' })
  );
  assert.deepEqual(failed, {
    candidates: [],
    generators: { 'profile-similarity': 0, trigram: 0 },
    dropped: 0,
    // Both signals, in stage order. A `degraded` that is assigned rather than
    // accumulated reports only the trigram failure, and the operator chases a
    // database while the embedder is the thing that is down.
    degraded: 'no-profile-similarity,no-trigram',
  });
});

test('a trigram fault costs the trigram leg and not the profile leg', async () => {
  const pool = stubPool({
    dense: [denseRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.3)],
    trigramFails: true,
  });
  const { handler } = embedderStub();
  const { candidates, generators, degraded } = await withStubbedFetch(handler, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkText: 'COLLAROY' })
  );
  assert.equal(degraded, 'no-trigram');
  assert.deepEqual(keysOf(candidates), ['Vessel:COLLAROY'], 'one leg failing does not discard the other leg’s work');
  assert.deepEqual(generators, { 'profile-similarity': 1, trigram: 0 });
});

test('a broken profile table is a fault, not a degradation', async () => {
  // The asymmetry with the trigram leg above, and it is deliberate. The profile
  // leg catches `.unavailable` only, so a SQL fault there propagates and a
  // genuinely broken entity_profiles still fails loudly — the same handler shape
  // as lib/corpus/search.js's dense leg.
  const pool = stubPool({ denseFails: true });
  const { handler } = embedderStub();
  await assert.rejects(
    () => withStubbedFetch(handler, () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })),
    (err) => {
      assert.match(err.message, /relation "entity_profiles" does not exist/);
      return true;
    }
  );
});

test('a reachable embedder that cannot name one model fails loudly rather than searching a space it cannot name', async () => {
  // Not `.unavailable`, so it does not degrade: an embedder serving two models is
  // up and answering, and binding a guessed identity to the predicate searches
  // one of two spaces at random. The message fragment is per-shape, because
  // probeServedModel raises on several malformed model lists and an assertion on
  // the error class alone survives a mutation that swaps two of those branches.
  const pool = stubPool();
  const { handler } = embedderStub({ models: { object: 'list', data: [{ id: 'bge-m3' }, { id: 'e5-large-v2' }] } });
  await assert.rejects(
    () => withStubbedFetch(handler, () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x' })),
    (err) => {
      assert.match(err.message, /serves 2 models/, 'the failure names how many models were served');
      assert.match(err.message, /bge-m3, e5-large-v2/, 'and which');
      assert.ok(!err.unavailable, 'a reachable server answering wrongly is a defect, not an outage');
      return true;
    }
  );
  assert.equal(pool.seen.length, 0, 'nothing was queried under a guessed embedding-space identity');
});

// ------------------------------------------------ a caller-supplied embedding

test('a chunk embedding already in hand is searched in its own space, with no round trip to the embedder', async () => {
  // The chunk's stored vector belongs to the space its own embed_model names,
  // which is not necessarily the space the embedder serves today. Binding the
  // LIVE identity to a stored vector's query compares two spaces, which is the
  // failure the composed identity exists to prevent.
  assert.equal(RETIRED_MODEL_SAME_SERVICE.split(':')[0], CURRENT_MODEL.split(':')[0],
    'the bait shares the service half, or it would be excluded by the very check it exists to test');

  const pool = stubPool({ dense: [denseRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.25)] });
  const { candidates } = await withStubbedFetch(forbiddenFetch, () =>
    generateCandidates(pool, {
      chunkId: 'c1',
      chunkText: 'COLLAROY',
      chunkEmbedding: vectorOf(0.02),
      chunkEmbedModel: RETIRED_MODEL_SAME_SERVICE,
    })
  );
  assert.equal(
    boundTo(denseCall(pool), /embed_model\s*=\s*\$(\d+)/, 'the embedding-space predicate'),
    RETIRED_MODEL_SAME_SERVICE,
    'the space searched is the one the caller’s vector lives in, not the one the embedder serves now'
  );
  assert.equal(candidates.length, 1);
  close(candidates[0].cosineSimilarity, 0.75, 'cosine similarity is 1 - distance');
});

test('a chunk embedding with a hole in it never reaches Postgres as a vector literal', async () => {
  // `[0.02,,0.02]` is what Array.prototype.join makes of a hole, and pgvector
  // takes it as far as a syntax error at the database — by which point the fault
  // is attributed to the wrong layer. A caller-supplied vector never passes
  // through lib/embed.js's own checks, so this is the only place it is checked.
  //
  // THIS is the test that kills `.forEach`: forEach never visits a hole, so a
  // guard written with it passes the sparse vector through silently. The message
  // fragment is per-shape, because the wrong-length branch below raises the same
  // way and a test asserting only the class survives a swap of the two.
  const holed = vectorOf(0.02);
  delete holed[7];
  assert.equal(holed.length, VECTOR_DIMENSIONS, 'still the right length, so a length check alone cannot see it');
  assert.ok(!(7 in holed), 'position 7 is a hole');

  const pool = stubPool();
  await assert.rejects(
    () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', chunkEmbedding: holed, chunkEmbedModel: CURRENT_MODEL }),
    (err) => {
      assert.match(err.message, /component 7 is not a finite number/, 'the failure names the position');
      assert.ok(!err.unavailable, 'a malformed vector from a caller is a defect, not an outage to degrade past');
      return true;
    }
  );

  await assert.rejects(
    () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', chunkEmbedding: [0.1, 0.2, 0.3], chunkEmbedModel: CURRENT_MODEL }),
    (err) => {
      assert.match(err.message, /expected 1024 dimensions, got 3/, 'a different shape of wrongness, said differently');
      return true;
    }
  );
  assert.equal(pool.seen.length, 0, 'neither malformed vector reached a query');
});

test('a chunk embedding without its embedding-space identity is refused, and so is the reverse', async () => {
  // A vector with no model identity cannot be given a predicate, and the two
  // available wrong answers are both silent: bind the live identity and compare
  // two spaces, or bind undefined and match no row while looking like "no similar
  // profiles". Each direction says which half is missing, so the two branches are
  // distinguishable from each other.
  const pool = stubPool();
  await assert.rejects(
    () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', chunkEmbedding: vectorOf(0.02) }),
    (err) => {
      assert.match(err.message, /chunkEmbedding was given without chunkEmbedModel/);
      return true;
    }
  );
  await assert.rejects(
    () => generateCandidates(pool, { chunkId: 'c1', chunkText: 'x', chunkEmbedModel: CURRENT_MODEL }),
    (err) => {
      assert.match(err.message, /chunkEmbedModel was given without chunkEmbedding/);
      return true;
    }
  );
  assert.equal(pool.seen.length, 0);
});

test('nothing to search with is named, and costs neither a query nor a round trip', async () => {
  // Not an error and not an empty success: a chunk with no text is a chunk that
  // was never extracted, and the caller has to be able to tell that from a chunk
  // whose text matched nothing.
  for (const input of [{}, { chunkText: '' }, { chunkText: '   ' }, { chunkText: null }]) {
    const pool = stubPool();
    const result = await withStubbedFetch(forbiddenFetch, () =>
      generateCandidates(pool, { chunkId: 'c1', ...input })
    );
    assert.deepEqual(result, {
      candidates: [], generators: { 'profile-similarity': 0, trigram: 0 }, dropped: 0, degraded: 'no-chunk-text',
    }, `input ${JSON.stringify(input)}`);
    assert.equal(pool.seen.length, 0, 'no query at all');
  }

  // A vector with no text is half a search: the profile leg runs, the trigram leg
  // has nothing to match, and the result says so rather than looking complete.
  const pool = stubPool({ dense: [denseRow('Vessel:COLLAROY', 'Vessel', 'COLLAROY', 0.25)] });
  const partial = await withStubbedFetch(forbiddenFetch, () =>
    generateCandidates(pool, { chunkId: 'c1', chunkEmbedding: vectorOf(0.02), chunkEmbedModel: CURRENT_MODEL })
  );
  assert.equal(partial.degraded, 'no-chunk-text');
  assert.deepEqual(keysOf(partial.candidates), ['Vessel:COLLAROY']);
  assert.deepEqual(partial.generators, { 'profile-similarity': 1, trigram: 0 });
  assert.equal(trigramCall(pool), undefined, 'no trigram query was issued against text that does not exist');
});
