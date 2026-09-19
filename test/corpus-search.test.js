// test/corpus-search.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchChunks, RRF_K } from '../lib/corpus/search.js';
import { _resetModelProbe } from '../lib/embed.js';
// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
// `bge_8005` is the service identity the adapter composes from the host; every
// stub in this file routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';

const EMBEDDING = Array.from({ length: 1024 }, () => 0.01);

function stubPool(rowsByLeg) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      seen.push({ sql, params });
      // The foreign-embedding-space count is a query of its own, so the stub
      // answers it as one. Without this branch it fell through to the lexical
      // return and the count read `mixed` off a chunk row — undefined — so every
      // test would have seen zero excluded for the wrong reason.
      if (/count\(\*\)/i.test(sql)) {
        // A plain Error, deliberately without the `.unavailable` tag the handlers
        // either side degrade on. The count's own handler absorbs any failure,
        // because a diagnostic round trip must not be able to fail a search whose
        // dense leg already succeeded.
        if (rowsByLeg.countFailure) throw rowsByLeg.countFailure;
        return { rows: [{ mixed: String(rowsByLeg.mixedCount ?? 0) }] };
      }
      if (/<=>/.test(sql)) return { rows: rowsByLeg.dense };
      return { rows: rowsByLeg.lexical };
    },
  };
}

// Resolves a `$n` placeholder in a query back to the value that was bound to it,
// so an assertion can say "this predicate is bound to the service" rather than
// only "this predicate exists and this value appears somewhere in the params".
function boundAt({ sql, params }, pattern, message) {
  const match = sql.match(pattern);
  assert.ok(match, message);
  return params[Number(match[1]) - 1];
}

// Resets the per-process model probe cache as well as swapping fetch. Without
// the reset the first test in this file to embed anything would fix the model
// identity for every test after it, and a stub that served a DIFFERENT model
// later would go unnoticed — the cache would answer from the first one.
const withStubbedFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  _resetModelProbe();
  try { return await fn(); } finally { globalThis.fetch = real; _resetModelProbe(); }
};

// What the reference embedding endpoint answered, probed 2026-08-17: one entry, and
// `meta.n_embd` is the dimension the server actually serves.
const MODELS_BODY = {
  object: 'list',
  data: [{ id: 'bge-m3', object: 'model', owned_by: 'llamacpp', meta: { n_embd: 1024 } }],
};

// Routes the model probe separately from the vectors. This previously answered
// EVERY url with the embeddings body, which meant a probe reading the wrong field
// would have been handed an embedding row and passed.
const embedOk = async (url) => {
  if (String(url).endsWith('/v1/models')) return { ok: true, json: async () => MODELS_BODY };
  return { ok: true, json: async () => ({ model: 'bge-m3', data: [{ index: 0, embedding: EMBEDDING }] }) };
};

test('the scope predicate is in the SQL, not applied afterwards', async () => {
  const pool = stubPool({ dense: [], lexical: [] });
  await withStubbedFetch(embedOk, () =>
    searchChunks(pool, { query: 'gastro outbreak', caseIds: ['case-1', 'case-2'], clearance: 1 })
  );
  assert.ok(pool.seen.length >= 2, 'both retrieval legs ran');
  for (const { sql, params } of pool.seen) {
    assert.match(sql, /case_id = ANY/, 'every query carries the case scope');
    assert.match(sql, /clearance <=/, 'every query carries the clearance ceiling');
    assert.ok(params.some((p) => Array.isArray(p) && p.includes('case-1')), 'the case list is bound, not interpolated');
  }
});

test('an empty case list returns nothing and touches no database', async () => {
  // A session with no cases must not fall through to an unscoped search.
  const pool = stubPool({ dense: [], lexical: [] });
  const { hits, degraded } = await withStubbedFetch(embedOk, () =>
    searchChunks(pool, { query: 'anything', caseIds: [], clearance: 3 })
  );
  assert.deepEqual(hits, []);
  assert.equal(degraded, 'no-scope');
  assert.equal(pool.seen.length, 0);
});

test('results from both legs are fused by reciprocal rank', async () => {
  const pool = stubPool({
    dense: [{ id: 'c1', doc_id: 'd1', content: 'alpha' }, { id: 'c2', doc_id: 'd1', content: 'beta' }],
    lexical: [{ id: 'c2', doc_id: 'd1', content: 'beta' }, { id: 'c3', doc_id: 'd2', content: 'gamma' }],
  });
  const rerankOff = async (url) => {
    if (String(url).includes('/rerank')) throw new Error('connect ECONNREFUSED');
    return embedOk(url);
  };
  const { hits, degraded } = await withStubbedFetch(rerankOff, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(degraded, 'no-rerank', 'a missing reranker is reported, not hidden');
  const byId = Object.fromEntries(hits.map((h) => [h.id, h]));
  // c2 appears in both legs, so its RRF score is the sum of two contributions.
  assert.ok(byId.c2.rrf > byId.c1.rrf, 'a chunk found by both legs outranks one found by either');
  assert.equal(byId.c2.rrf, 1 / (RRF_K + 2) + 1 / (RRF_K + 1));
});

test('the fusion constant is 60, the value the rest of the estate fuses at', async () => {
  // Found on 2026-08-17 by a mutation canary: RRF_K moved from 60 to 61 and the
  // whole suite stayed green. The assertion above imports RRF_K and recomputes
  // its expectation from it, so it pins the FORMULA and not the value — k could
  // drift to any number and nothing would notice, while fused ranking quietly
  // changed for every search in the product.
  //
  // k=60 is the value from Cormack, Clarke and Buettcher on reciprocal rank
  // fusion, which is the durable reference and the reason this number rather than
  // another; algolotl-mono's retrieval path uses the same value from the same
  // source, so two systems fusing at different k would stop producing comparable
  // rankings. Citing the paper rather than a path in another repo is deliberate:
  // a cross-repo line reference is the same drift this assertion exists to catch.
  assert.equal(RRF_K, 60);
});

test('a missing embedder falls back to lexical and says so', async () => {
  const pool = stubPool({ dense: [], lexical: [{ id: 'c9', doc_id: 'd9', content: 'lexical only' }] });
  // The model probe shares an origin with the vectors, so a host that refuses one
  // refuses the other. Letting the probe answer while the vectors failed would be
  // a state no deployment can be in.
  const embedOff = async (url) => {
    const u = String(url);
    if (u.includes('/embeddings') || u.endsWith('/v1/models')) throw new Error('connect ECONNREFUSED');
    return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 2.0 }] }) };
  };
  const { hits, degraded } = await withStubbedFetch(embedOff, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(degraded, 'no-dense-retrieval');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'c9');
});

test('when both the embedder and the reranker are unavailable, both failures are reported, not just the first', async () => {
  const pool = stubPool({ dense: [], lexical: [{ id: 'c9', doc_id: 'd9', content: 'lexical only' }] });
  const bothDown = async () => { throw new Error('connect ECONNREFUSED'); };
  const { hits, degraded } = await withStubbedFetch(bothDown, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(
    degraded,
    'no-dense-retrieval,no-rerank',
    'a caller told only "no-dense-retrieval" would never learn the results were also unreranked'
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'c9');
});

test('a reranked score is attached to the chunk it actually belongs to, not the position it landed in', async () => {
  // Two candidates, and the reranker flips their order: candidate index 1
  // (the SECOND dense hit) scores higher than candidate index 0. If the
  // mapping back from reranker result to candidate used the result's
  // position in the output array instead of its `index` field, this would
  // attach the high score to the wrong chunk's id/content.
  const pool = stubPool({
    dense: [
      { id: 'c1', doc_id: 'd1', content: 'first content' },
      { id: 'c2', doc_id: 'd1', content: 'second content' },
    ],
    lexical: [],
  });
  const rerankReorders = async (url) => {
    if (String(url).includes('/rerank')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            { index: 1, relevance_score: 5 },
            { index: 0, relevance_score: -5 },
          ],
        }),
      };
    }
    return embedOk(url);
  };
  const { hits } = await withStubbedFetch(rerankReorders, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(hits.length, 2);
  assert.ok(hits[0].score > hits[1].score, 'the higher reranker score sorts first');
  assert.equal(hits[0].id, 'c2', 'candidate index 1 scored highest, so the top hit must be c2, not whatever sits at position 0');
  assert.equal(hits[0].content, 'second content');
  assert.equal(hits[1].id, 'c1');
  assert.equal(hits[1].content, 'first content');
});

// Spec section 10: "A chunk embedded by a different embed_model is excluded
// from a search, and the exclusion is reported."
//
// Two embedding models produce two incompatible vector spaces in one column,
// and cosine distance between them is arithmetic that means nothing. It does
// not error — it returns confidently wrong neighbours. The column exists so
// this is a query that can be written rather than a defect that has to be
// inferred, and this is the query.
//
// These four cases are white-box: with a stub pool no SQL is executed, so they
// pin the predicate and the values bound to it, not the rows it removes. The
// behavioural half — a chunk whose text is byte-identical to an included one
// and whose only difference is its embedding space, absent from the result, and
// retrievable without the predicate so its absence proves something — needs
// Postgres and lives in test/corpus-search-integration.test.js.
test('the dense leg is restricted to the embedding model that produced the query vector', async () => {
  const pool = stubPool({ dense: [], lexical: [] });
  await withStubbedFetch(embedOk, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  const dense = pool.seen.find(({ sql }) => /<=>/.test(sql));
  assert.ok(dense, 'the dense leg ran');
  assert.match(dense.sql, /embed_model\s*=\s*\$/, 'the dense leg pins the embedding model');
  // The LITERAL composed identifier, `service:model`. Binding the service alone
  // (`bge_8005`) is the defect: a service is a serving endpoint, so re-pointing
  // the same registry service at a different 1024-dimension model leaves
  // embed_model unchanged, matches both embedding spaces with one predicate, and
  // makes cosine distance across them return confident nonsense. EMBED_DIM cannot
  // catch it — both models are 1024.
  assert.ok(
    dense.params.includes('bge_8005:bge-m3'),
    'the pinned value identifies the MODEL as well as the service, bound not interpolated'
  );
  assert.ok(
    !dense.params.includes('bge_8005'),
    'the bare service must not be what is bound, or one identifier still covers two embedding spaces'
  );
});

test('chunks in a foreign embedding space are counted, not silently dropped', async () => {
  // The count comes from a second query, so a caller can tell "this case has
  // 900 chunks nobody re-embedded" from "this case is empty".
  const pool = stubPool({ dense: [], lexical: [], mixedCount: 3 });
  const { mixedEmbedModelExcluded } = await withStubbedFetch(embedOk, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(mixedEmbedModelExcluded, 3, 'the exclusion is reported as a number, not left implicit');
  assert.ok(
    pool.seen.some(({ sql }) => /count\(\*\)/i.test(sql) && !/<=>/.test(sql)),
    'the count is its own query, not read off the dense leg it is counting the complement of'
  );
});

test('a search that excludes nothing reports zero rather than omitting the count', async () => {
  // The exclusion test above passes just as well for a predicate that excludes
  // EVERYTHING, and so does the empty result such a predicate produces. This is
  // the case that separates them: rows come back from the dense leg AND the
  // count is zero. A `mixedEmbedModelExcluded` that were only set when non-zero
  // would leave a caller unable to tell "nothing was held back" from "nobody
  // looked", so the key has to be present at zero, not merely falsy.
  const pool = stubPool({
    dense: [{ id: 'c1', doc_id: 'd1', content: 'in the current space' }],
    lexical: [],
    mixedCount: 0,
  });
  const rerankOk = async (url) => {
    if (String(url).includes('/rerank')) {
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) };
    }
    return embedOk(url);
  };
  const result = await withStubbedFetch(rerankOk, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(result.degraded, null, 'nothing failed in this run');
  assert.equal(result.hits.length, 1, 'the current-space chunk is returned, so the predicate did not exclude everything');
  assert.ok(
    Object.hasOwn(result, 'mixedEmbedModelExcluded'),
    'the count is reported on a clean run too — an absent key reads as "nobody looked"'
  );
  assert.equal(result.mixedEmbedModelExcluded, 0);
});

test('the exclusion count is the exact complement of the dense predicate, bound to the same service', async () => {
  // A count taken over a different population, or against a different value
  // from the one the dense leg pinned, is a wrong number rather than a smaller
  // one — and it is the number an operator would use to decide whether a case
  // needs re-embedding.
  const pool = stubPool({ dense: [], lexical: [] });
  await withStubbedFetch(embedOk, () =>
    searchChunks(pool, { query: 'q', caseIds: ['case-1', 'case-2'], clearance: 2 })
  );
  const dense = pool.seen.find(({ sql }) => /<=>/.test(sql));
  const counted = pool.seen.find(({ sql }) => /count\(\*\)/i.test(sql));
  assert.ok(dense, 'the dense leg ran');
  assert.ok(counted, 'the exclusion count ran');

  const included = boundAt(dense, /embed_model\s*=\s*\$(\d+)/, 'the dense leg pins the embedding model');
  const excluded = boundAt(
    counted,
    /embed_model\s+IS\s+DISTINCT\s+FROM\s+\$(\d+)/i,
    // IS DISTINCT FROM rather than <>: a chunk with a NULL embed_model is
    // excluded by `= $n` too, and `<> $n` would not count it.
    'the count uses IS DISTINCT FROM, so a NULL embed_model is counted as excluded like the dense leg excludes it'
  );
  // The literal, and both sides of the complement. A count bound to the bare
  // service while the dense leg pinned `service:model` would report the
  // complement of a predicate that was never applied — a wrong number, and the
  // one an operator uses to decide whether a case needs re-embedding.
  assert.equal(included, 'bge_8005:bge-m3', 'the dense leg pins the service AND the model that produced the query vector');
  assert.equal(excluded, included, 'the count is the complement of the predicate actually applied, not of a second guess at it');
  assert.deepEqual(
    counted.params.slice(0, 2),
    dense.params.slice(0, 2),
    'the count is over the same case scope and the same clearance ceiling as the dense leg'
  );

  // The population term, and it is the one that makes these two predicates
  // complements of each other rather than counts over different sets. Found
  // unasserted on 2026-08-17 by mutation: removing `AND embedding IS NOT NULL`
  // from the count query left all 603 tests green, and removing it from the DENSE
  // leg — where it predates this task — was green too. Without it the count
  // includes chunks with no embedding at all, inflating the number an operator
  // uses to decide whether a case needs RE-embedding with rows that were never
  // embedded once. Different problem, different remedy, and this test claimed
  // exactness while checking neither.
  assert.match(dense.sql, /embedding IS NOT NULL/, 'the dense leg looks only at embedded chunks');
  assert.match(
    counted.sql,
    /embedding IS NOT NULL/,
    'and so does its complement, or the two run over different populations and the count is a wrong number rather than a smaller one'
  );
});

test('the exclusion count reaches the caller on all four return paths', async () => {
  // searchChunks has four exits. A field threaded onto three of them is a field
  // whose type depends on which path answered, so every caller needs a guard.
  // Each block below lands on a DIFFERENT one — an earlier version of this test
  // reached only two, because its third stub threw for every URL and so landed on
  // the same catch as its second.
  const oneDenseRow = [{ id: 'c1', doc_id: 'd1', content: 'in the current space' }];
  const rerankScores = async (url) => {
    if (String(url).includes('/rerank')) {
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) };
    }
    return embedOk(url);
  };
  const rerankOff = async (url) => {
    if (String(url).includes('/rerank')) throw new Error('connect ECONNREFUSED');
    return embedOk(url);
  };

  // Exit 1: no scope, before a query is issued at all.
  const unscoped = await withStubbedFetch(embedOk, () =>
    searchChunks(stubPool({ dense: [], lexical: [] }), { query: 'q', caseIds: [], clearance: 0 })
  );
  assert.equal(unscoped.degraded, 'no-scope');
  assert.equal(unscoped.mixedEmbedModelExcluded, 0, 'a search that never ran excluded nothing, and says so');

  // Exit 2: both legs ran and fused to nothing. This is the exit where the count
  // matters most — it is the only thing separating "this case is empty" from
  // "this case has 900 chunks nobody re-embedded", which look identical here.
  const empty = await withStubbedFetch(embedOk, () =>
    searchChunks(stubPool({ dense: [], lexical: [], mixedCount: 900 }), {
      query: 'q',
      caseIds: ['case-1'],
      clearance: 0,
    })
  );
  assert.deepEqual(empty.hits, []);
  assert.equal(empty.degraded, null, 'nothing failed; the case is simply empty in this embedding space');
  assert.equal(empty.mixedEmbedModelExcluded, 900);

  // Exit 3: reranked success, the path a healthy deployment takes.
  const reranked = await withStubbedFetch(rerankScores, () =>
    searchChunks(stubPool({ dense: oneDenseRow, lexical: [], mixedCount: 4 }), {
      query: 'q',
      caseIds: ['case-1'],
      clearance: 0,
    })
  );
  assert.equal(reranked.degraded, null);
  assert.equal(reranked.hits.length, 1);
  assert.equal(reranked.mixedEmbedModelExcluded, 4);

  // Exit 4: fused rank alone.
  const unreranked = await withStubbedFetch(rerankOff, () =>
    searchChunks(stubPool({ dense: oneDenseRow, lexical: [], mixedCount: 7 }), {
      query: 'q',
      caseIds: ['case-1'],
      clearance: 0,
    })
  );
  assert.equal(unreranked.degraded, 'no-rerank');
  assert.equal(unreranked.mixedEmbedModelExcluded, 7, 'a missing reranker does not lose the count the dense leg already took');
});

test('a failed exclusion count degrades by name and leaves the search it was diagnosing intact', async () => {
  // The count is a second round trip that exists only to explain a thin result.
  // Placed inside the dense leg's try, as it first was, it could take down a
  // search that had already retrieved its rows — a diagnostic destroying the
  // thing it was there to describe, and with no signal saying so. It gets its own
  // handler for that reason, and that handler absorbs a PLAIN error rather than
  // only an `.unavailable` one, which is the opposite of the rule the handlers
  // either side follow. That asymmetry is deliberate and this is where it is
  // pinned.
  const countDown = {
    dense: [{ id: 'c1', doc_id: 'd1', content: 'retrieved before the count was attempted' }],
    lexical: [],
    countFailure: new Error('canceling statement due to statement timeout'),
  };
  const rerankScores = async (url) => {
    if (String(url).includes('/rerank')) {
      return { ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) };
    }
    return embedOk(url);
  };

  const survived = await withStubbedFetch(rerankScores, () =>
    searchChunks(stubPool(countDown), { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(survived.hits.length, 1, 'the rows the dense leg already had are still served');
  assert.equal(survived.hits[0].id, 'c1');
  assert.equal(survived.degraded, 'no-exclusion-count', 'the failure is named, not swallowed and not fatal');
  assert.equal(survived.mixedEmbedModelExcluded, 0, 'nothing could be counted, and the field keeps its type');

  // And it composes. Two failures, neither buried, in the order of the stages
  // that produced them — the same discipline as no-dense-retrieval,no-rerank.
  const rerankOff = async (url) => {
    if (String(url).includes('/rerank')) throw new Error('connect ECONNREFUSED');
    return embedOk(url);
  };
  const both = await withStubbedFetch(rerankOff, () =>
    searchChunks(stubPool(countDown), { query: 'q', caseIds: ['case-1'], clearance: 0 })
  );
  assert.equal(both.degraded, 'no-exclusion-count,no-rerank');
});

test('a dense leg that never ran reports no exclusions, whatever the table holds', async () => {
  // Signal composition when the embedder is gone. Both stubbed services are down,
  // so this lands on the same exit as the no-rerank case above; what it pins is
  // that the two signals compose and that the count is 0 rather than the 7 the
  // stub would have answered — with no dense leg there was no embedding-space
  // predicate, so this search held nothing back, and no-dense-retrieval is what
  // tells the caller the leg is missing.
  const bothDown = async () => { throw new Error('connect ECONNREFUSED'); };
  const denseless = await withStubbedFetch(bothDown, () =>
    searchChunks(
      stubPool({ dense: [], lexical: [{ id: 'c9', doc_id: 'd9', content: 'lexical only' }], mixedCount: 7 }),
      { query: 'q', caseIds: ['case-1'], clearance: 0 }
    )
  );
  assert.equal(denseless.degraded, 'no-dense-retrieval,no-rerank');
  assert.equal(denseless.mixedEmbedModelExcluded, 0);
  assert.ok(
    !denseless.degraded.includes('no-exclusion-count'),
    'the count was not attempted rather than attempted and failed, and the two must not read alike'
  );
});
