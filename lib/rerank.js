// lib/rerank.js
//
// Cross-encoder scoring for link decisions and retrieval reranking.
//
// This replaces asking a large generative model whether a headline refers to an
// entity. Measured 2026-08-16 on the same 40 candidate pairs: the generative
// path took 17,109 ms with reasoning off and produced nothing parseable with it
// on, against 435 ms for bge-reranker-v2-m3 as 40 serial calls and 69 ms as one
// batch. The cross-encoder is trained for exactly this judgement; the generative
// model was being asked to emit a boolean through autoregressive decoding. The
// full table, including the earlier figures against the model that used to serve
// this role, is in lib/ontology/score.js.
//
// The HTTP lives in lib/llm.js. This file previously defaulted to
// `http://localhost:8006/v1/rerank`, which is the same defect the shared client
// exists to remove: it happens to work on one host because haproxy runs there, and
// anywhere else it fails into a silent `.unavailable` degrade. Resolution is now
// through the adapter, and every call carries X-Algolotl-App so it can be costed.
//
// The numeric validation below now happens in the client too, as of
// @axoquant/llm 0.3.0 (github:axoquant/llm#6e267b6), which is where it belongs.
// It stays here anyway. A consumer that trusts a shared client completely is one
// version pin away from the bug it was written to survive, and this file is
// pinned by commit, so a downgrade is an edit to package.json rather than an
// event anyone would notice.
//
// Keeping it cost something, and the cost was paid rather than waved at. The
// client validating first made this file's loop unreachable through the `fetch`
// stub every test of it used, and an unreachable guard is one nobody can prove
// works. It is now reached by replacing the client's exported rerank() through a
// resolve hook, in test/rerank-guard.test.js; test/rerank.test.js keeps the
// `fetch` stub and pins the other half, which is how a refusal raised by the
// CLIENT gets classified here.

import { rerank as scoreDocuments } from './llm.js';

const DEFAULT_APP = 'philotas/rerank';
const DEFAULT_TIMEOUT_MS = 15_000;

export class RerankUnavailable extends Error {
  constructor(detail) {
    super(`rerank unavailable: ${detail}`);
    this.name = 'RerankUnavailable';
    this.unavailable = true;
    this.reason = 'transport';
  }
}

export class RerankMalformed extends Error {
  constructor(detail) {
    super(`rerank malformed response: ${detail}`);
    this.name = 'RerankMalformed';
    this.unavailable = true;
    this.malformed = true;
    this.reason = 'malformed-response';
  }
}

// The model emits unbounded logits. Callers compare against calibrated
// probability thresholds, so convert here rather than leaving every call site
// to remember. The raw logit rides along for debugging and for anyone who
// wants to recalibrate without a second round trip.
//
// The shared client deliberately does NOT do this: it returns the service's
// raw relevance_score, because a caller ranking by score does not need a
// probability and a monotone transform would not change the ranking. Only
// callers with calibrated thresholds — which is this project — need it.
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Score documents against a query.
 *
 * Returns `{index, logit, score}` sorted by score DESCENDING, where `index` is
 * the position in the `documents` array as passed. Callers must read `index`
 * rather than assuming position — that is what makes the ordering safe.
 *
 * The client returns scores in input order. Up to 0.2.1 it filled any index the
 * service omitted with 0.0, which sigmoids to 0.5; 0.3.0 refuses a short result
 * list instead, precisely because 0 is a real confident-non-match score and an
 * invented one could not be told from it. Either way the service returns one
 * result per document, because the client sends no `top_n`; truncation happens
 * here instead. That is strictly more information than before, when `top_n`
 * made the service truncate and the sort ran on an already-cut set.
 */
export async function rerank(query, documents, { topN, timeoutMs = DEFAULT_TIMEOUT_MS, app = DEFAULT_APP } = {}) {
  if (!documents || documents.length === 0) return [];

  let logits;
  try {
    logits = (await scoreDocuments(query, documents, { app, timeoutMs })).scores;
  } catch (err) {
    // A contract break the CLIENT caught is still a contract break, and it is
    // not an outage. @axoquant/llm 0.3.0 raises MalformedResponse for a
    // non-finite relevance_score, an index outside the batch, a duplicate index
    // and a short result list, and tags every one of them `.malformed`; before
    // 0.3.0 none of those existed and everything arriving here really was
    // transport. Re-classified rather than flattened, because both states
    // degrade identically — see the `.unavailable` note below — so the log line
    // is the ONLY thing that tells an operator whether to go and look at a
    // service, and a malformed response means the service is up and answering.
    //
    // Switched on the own property, not on `instanceof MalformedResponse`. Next
    // bundles per route, so a class identity duplicated across bundles makes
    // `instanceof` answer false for an error raised by the same source file —
    // silently, and in the direction of misreporting every malformed response as
    // an outage. lib/errors.js brands DisclosableError by own property for
    // exactly this reason, and the client documents the tag as the supported
    // seam. `=== true` so a driver error carrying an unrelated truthy
    // `malformed` field cannot claim the classification.
    if (err?.malformed === true) throw new RerankMalformed(err.message);
    // Named rather than swallowed, and tagged `.unavailable` so callers can
    // tell "the scorer is down" from "the scorer said no".
    throw new RerankUnavailable(err?.cause?.code || err.message);
  }

  // Checked BEFORE the sigmoid, and before the sort that consumes its output.
  //
  // DEFENCE IN DEPTH as of @axoquant/llm 0.3.0. The client now refuses a
  // non-finite `relevance_score` itself, with `MalformedResponse`, so in the
  // pinned version nothing invalid should reach this loop. Up to 0.2.1 it did no
  // numeric validation at all — it assigned `scores[item.index] =
  // item.relevance_score` straight from the parsed body — and this loop was the
  // only thing between the wire and a stored link decision. Kept, because the
  // pin is one edit away from a version without it, and because the enumeration
  // below is the record of WHY each value matters to this project specifically.
  //
  // Kept AND reachable, which is the part that is not free. Nothing invalid gets
  // past the client, so no `fetch` stub can put a value in front of this loop any
  // more; test/rerank-guard.test.js replaces the client's exported rerank()
  // through a `node:module` resolve hook and drives each value below straight in.
  // Without that seam this would be an untested guard with a comment claiming it
  // protects something, and the honest choice would have been to delete it.
  //
  // `Number.isFinite`, not `typeof logit === 'number'`: the latter is true for
  // NaN and for both Infinities. What is excluded, and why each one matters:
  //
  //   NaN        sigmoid(NaN) is NaN. It fails both the `>= ACCEPT_THRESHOLD`
  //              and the `<= REJECT_THRESHOLD` comparison in
  //              lib/ontology/score.js, so the candidate falls through to the
  //              band and a broken upstream is recorded as model uncertainty —
  //              which poisons the one count that exists to make a too-wide
  //              band visible. As a sort key it also corrupts the relative
  //              order of the VALID entries, not merely its own position:
  //              measured 2026-08-17 on node v22.22.2, 1,805 of 5,000 randomly
  //              ordered 50-document batches carrying one NaN came back
  //              misordered, against 0 of the same 5,000 with all-numeric
  //              scores. And JSON.stringify(NaN) is `null`, so it reaches
  //              /api/corpus/search as "score": null.
  //   +Infinity  sigmoid is 1. A confident ACCEPT, not an error.
  //   -Infinity  sigmoid is 0. A confident REJECT, not an error.
  //   null       -null is 0, so sigmoid is 0.5: a plausible mid-band score
  //              invented out of a missing value.
  //   undefined  an absent relevance_score key, or a hole the client left when
  //              the service named an index outside the batch. A plain indexed
  //              loop is used here so holes are read as undefined rather than
  //              skipped the way .every() would skip them.
  //   "0.5"      unary minus coerces a numeric string, so a broken response
  //              type reads as a working one. Coercing here would hide the
  //              contract break instead of reporting it.
  //
  // A genuine 0 is finite and must pass, and sigmoids to exactly 0.5. It is a
  // real reranker output — a confident non-match — which is why 0.3.0 stopped
  // filling an unscored index with it and refuses the short list instead: a
  // padded 0 could not be told from a measured one.
  //
  // Tagged `.unavailable` so lib/corpus/search.js degrades to fused RRF rank
  // under the named signal `no-rerank` and lib/ontology/score.js reports
  // `degraded: 'rerank-unavailable'`, rather than 500-ing the request. It gets
  // its own class and `.reason` because "the scorer answered with nonsense" is
  // a third state: collapsing it into the outage sends an operator to check a
  // service that is up and replying.
  for (let index = 0; index < logits.length; index++) {
    const logit = logits[index];
    if (!Number.isFinite(logit)) {
      throw new RerankMalformed(`index ${index} scored ${String(logit)} (${typeof logit})`);
    }
  }

  return logits
    .map((logit, index) => ({ index, logit, score: sigmoid(logit) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN ?? documents.length);
}
