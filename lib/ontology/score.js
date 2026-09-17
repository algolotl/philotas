// lib/ontology/score.js
//
// Whether a headline refers to a specific entity, decided by a cross-encoder.
//
// This replaces a batched prompt to a generative model. First measured
// 2026-08-15 against qwen3next-80b: 17,585 ms for the generative model against
// 145 ms for bge-reranker-v2-m3, with the generative path sitting at 12% of its
// timeout budget and 10% of its token ceiling, both of which failed silently.
//
// Re-measured 2026-08-16 because the `assistant` role now resolves to a dense
// 27B, not that MoE, so the original figures described a model that no longer
// serves this path. Same 40 candidate pairs, through @axoquant/llm:
//
//   generative, reasoning on    54,576 ms   and returned unparseable output —
//                                           it spent the budget thinking and
//                                           never emitted the JSON
//   generative, noThinking      17,109 ms   1,782 tokens, 40 verdicts
//   judge role, noThinking       9,057 ms   but wrapped its JSON in a ```json
//                                           fence despite response_format, so
//                                           it did not parse either
//   cross-encoder, 40 calls        435 ms   40 scored
//   cross-encoder, one batch        69 ms   40 scored
//
// The model changed and the conclusion did not: 39x on the serial form, 248x
// batched. Reasoning-on is not a slower version of the right answer, it is a
// different failure — the same one the governor hit before noThinking landed.
//
// The thresholds below are PROVISIONAL. The spec calls for them to be derived
// from a hand-labelled gold set with a reported AUC, which is a later plan.
// Until then they are deliberately wide, so the band is large and the system
// declines to decide rather than deciding badly.

import { rerank } from '../rerank.js';

export const ACCEPT_THRESHOLD = 0.80;
export const REJECT_THRESHOLD = 0.20;

// The query side of the pair. The cross-encoder was trained on
// (query, document) pairs, and the entity is the thing being looked up, so the
// entity descriptor is the query and the headline is the document.
const queryFor = (c) => `${c.entity}${c.hint ? ` (${c.hint})` : ''}`;

export async function scoreCandidates(candidates) {
  if (!candidates || candidates.length === 0) {
    return { verdicts: [], banded: 0, degraded: null };
  }

  // One rerank call per candidate: each has its own entity, so they cannot
  // share a query. At 145 ms for 40 pairs the per-call cost is small, and the
  // batch cap that constrained the generative path does not apply.
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    try {
      const [top] = await rerank(queryFor(candidates[i]), [candidates[i].headline], {
        topN: 1,
        app: 'parallax/entities',
      });
      if (top) scored.push({ i, score: top.score });
    } catch (err) {
      if (err?.unavailable) return { verdicts: [], banded: 0, degraded: 'rerank-unavailable' };
      throw err;
    }
  }

  const verdicts = [];
  let banded = 0;
  for (const { i, score } of scored) {
    if (score >= ACCEPT_THRESHOLD) {
      verdicts.push({
        i, keep: true, confidence: score, method: 'cross-encoder',
        why: `cross-encoder ${score.toFixed(2)}`,
      });
    } else if (score <= REJECT_THRESHOLD) {
      verdicts.push({
        i, keep: false, confidence: score, method: 'cross-encoder',
        why: `cross-encoder ${score.toFixed(2)}`,
      });
    } else {
      // Neither confident enough to assert nor to dismiss. Counted so the band
      // width is visible: a band that swallows most candidates means the
      // thresholds are wrong, and that should be observable rather than
      // expensive.
      banded += 1;
    }
  }
  return { verdicts, banded, degraded: null };
}
