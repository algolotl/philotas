// lib/corpus/search.js
//
// Hybrid retrieval: dense vectors and lexical full text, fused by reciprocal
// rank, then reranked by a cross-encoder.
//
// Scope is applied IN THE QUERY. Measured 2026-08-15 on 100,000 vector(1024)
// rows across 500 cases: pre-filtered in SQL returned all 10 requested results
// in 1.9 ms, while fetching the global top 1,000 and filtering afterwards
// returned ONE of the ten. Post-filtering is not a weaker security posture, it
// is a wrong answer.
//
// k=60 follows algolotl-mono (intranet/mcp/retrieval.py:70), which cites
// Cormack et al. Rank-only fusion is what makes two legs with incomparable
// score scales combinable at all.

import { embed } from '../embed.js';
import { rerank } from '../rerank.js';

export const RRF_K = 60;
const LEG_LIMIT = 50;

export async function searchChunks(pool, { query, caseIds, clearance = 0, limit = 10 }) {
  // A session with no cases must return nothing rather than falling through to
  // an unscoped search. This is the failure that would leak across tenants.
  // mixedEmbedModelExcluded is reported here too, so its type does not depend on
  // which exit a caller reached.
  if (!caseIds || caseIds.length === 0) return { hits: [], degraded: 'no-scope', mixedEmbedModelExcluded: 0 };

  // Named signals, comma-joined at every exit in the order of the stage that
  // produced them. A single string was enough while two things could fail; three
  // can now, and accumulating rather than assigning is what stops the third from
  // burying the first — the same reasoning as the no-rerank join below, applied
  // once instead of at each site.
  const degradedSignals = [];
  const degraded = () => (degradedSignals.length > 0 ? degradedSignals.join(',') : null);

  let denseRows = [];
  let mixedEmbedModelExcluded = 0;
  let embedModelBound = null;
  try {
    const { vectors, embedModel } = await embed([query], { app: 'philotas/corpus' });
    // `embedModel`, NOT `service`. This used to bind the registry's serving
    // endpoint identity (`bge_8005`) alone, and that predicate discriminated
    // embedding spaces only while one service served one model. Re-pointing the
    // same registry service at a different 1024-dimension model — an in-place
    // embedder upgrade on the same role and port, a routine operation — left
    // embed_model unchanged, so one predicate matched two spaces and cosine
    // distance across them returned confident nonsense with nothing reporting
    // it. EMBED_DIM could not catch it: both models are 1024.
    //
    // lib/embed.js now composes `service:model`, reading the model from the
    // embedder's own /v1/models. The residual gap is stated there and is worth
    // knowing here: the probe is cached per process, so a model swapped under a
    // RUNNING process is not noticed until restart.
    //
    // WHERE THIS PROPERLY BELONGS, AND NOW IS: @axoquant/llm. Up to 0.2.1 it
    // hardcoded `model: 'bge-m3'` in its request body and discarded the `model`
    // the response actually reports. 0.3.0 (github:axoquant/llm#6e267b6) returns
    // it from `embedWithModel()`, so the identity needs no second round trip.
    // lib/embed.js still probes, because the probe also catches a multi-entry
    // model list and checks `meta.n_embd` against EMBED_DIM before anything is
    // written; the cutover is its own task and must keep both.
    embedModelBound = embedModel;
    const literal = `[${vectors[0].join(',')}]`;
    const r = await pool.query(
      // embed_model is pinned, not filtered afterwards. Two embedding models in
      // one vector column are two incompatible spaces, and cosine distance
      // across them does not error — it returns confident nonsense. See the
      // note on embed_model in the spec's data model.
      `SELECT id, doc_id, content
         FROM chunks
        WHERE case_id = ANY($1) AND clearance <= $2
          AND embedding IS NOT NULL AND embed_model = $3
        ORDER BY embedding <=> $4::vector
        LIMIT $5`,
      [caseIds, clearance, embedModel, literal, LEG_LIMIT]
    );
    denseRows = r.rows;
  } catch (err) {
    if (!err?.unavailable) throw err;
    degradedSignals.push('no-dense-retrieval');
    // mixedEmbedModelExcluded stays 0, and that is the honest number rather than
    // a missing one: with no dense leg there was no embedding-space predicate, so
    // this search held nothing back. What the caller needs to know in that case
    // is that the leg is gone, and `degraded` says so.
  }

  // The population the predicate above excludes: how many chunks IN SCOPE sit in
  // a foreign embedding space. Not "what this search held back" — there is no
  // LIMIT here while the dense leg is capped at LEG_LIMIT — and the unbounded
  // number is the right one for the decision it informs, which is whether a case
  // needs re-embedding. A case whose chunks were all embedded by a retired model
  // would otherwise return nothing and look indistinguishable from an empty one.
  //
  // IS DISTINCT FROM rather than <>, and carrying the same `embedding IS NOT
  // NULL` and scope terms as the dense leg, so this is the exact COMPLEMENT of
  // that predicate rather than a count over a different population: a chunk with
  // a NULL embed_model is excluded by `embed_model = $3` too and `<> $3` would
  // not have counted it, while a chunk with no embedding at all is a different
  // problem with a different remedy and belongs in neither number.
  //
  // ITS OWN try, which is the point of the separation: the count is a diagnostic
  // that exists to explain a thin result, so it must never be able to destroy a
  // good one. Everything is absorbed here into a named signal, a deliberate
  // asymmetry with the handlers either side that rethrow anything without
  // `.unavailable`. It hides no real SQL fault — the lexical leg below queries
  // the same table with no such handler, so a broken `chunks` still fails the
  // search there — and by this point the dense query has already proved the
  // table readable.
  //
  // The cost of the extra round trip is **assumed** small next to the two
  // retrieval legs and has not been measured — it is a count over the same
  // (case_id, clearance) index the dense leg already scans. Measure it before
  // the trial if a scope grows past the ~20,000 chunks that lib/schema/
  // semantic.sql says would justify an HNSW index.
  if (embedModelBound !== null) {
    try {
      const excluded = await pool.query(
        `SELECT count(*) AS mixed
           FROM chunks
          WHERE case_id = ANY($1) AND clearance <= $2
            AND embedding IS NOT NULL AND embed_model IS DISTINCT FROM $3`,
        // The SAME composed identifier the dense leg pinned. Bound to anything
        // else this counts the complement of a predicate that was never applied.
        [caseIds, clearance, embedModelBound]
      );
      mixedEmbedModelExcluded = Number(excluded.rows[0]?.mixed ?? 0);
    } catch {
      // Named rather than swallowed: a caller reading a thin result has to be
      // able to tell "nothing was held back" from "nobody could count".
      degradedSignals.push('no-exclusion-count');
    }
  }

  const lexical = await pool.query(
    `SELECT id, doc_id, content
       FROM chunks
      WHERE case_id = ANY($1) AND clearance <= $2
        AND content_tsv @@ plainto_tsquery('english', $3)
      ORDER BY ts_rank(content_tsv, plainto_tsquery('english', $3)) DESC
      LIMIT $4`,
    [caseIds, clearance, query, LEG_LIMIT]
  );

  const fused = new Map();
  const contribute = (rows, legName) => {
    rows.forEach((row, i) => {
      const existing = fused.get(row.id) || { ...row, rrf: 0, dense_rank: null, lexical_rank: null };
      existing.rrf += 1 / (RRF_K + i + 1);
      existing[legName] = i + 1;
      fused.set(row.id, existing);
    });
  };
  contribute(denseRows, 'dense_rank');
  contribute(lexical.rows, 'lexical_rank');

  const candidates = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, LEG_LIMIT);
  if (candidates.length === 0) return { hits: [], degraded: degraded(), mixedEmbedModelExcluded };

  try {
    const scored = await rerank(query, candidates.map((c) => c.content), {
      topN: limit,
      app: 'philotas/corpus',
    });
    const hits = scored.map((s) => ({ ...candidates[s.index], score: s.score }));
    return { hits, degraded: degraded(), mixedEmbedModelExcluded };
  } catch (err) {
    if (!err?.unavailable) throw err;
    // Fused rank alone. Reported, because an operator reading these results
    // should know they were not reranked. When an earlier stage also failed,
    // every signal must survive: a comma-joined string keeps callers that
    // read `degraded` as a single string working, while still surfacing
    // that this response is both dense-less AND unreranked rather than
    // burying the first failure once a second one lands on top of it.
    degradedSignals.push('no-rerank');
    return {
      hits: candidates.slice(0, limit).map((c) => ({ ...c, score: c.rrf })),
      degraded: degraded(),
      mixedEmbedModelExcluded,
    };
  }
}
