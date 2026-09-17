// lib/embed.js
//
// Embeddings and token counts for the corpus layer.
//
// Two endpoints, one model. The registry's `embed` role produces the vectors;
// `/tokenize` on the same host produces token counts from the SAME tokenizer
// that will process the text at embed time. Counting characters and dividing by
// four is the usual shortcut and it silently mis-sizes chunks for any text that
// is not English prose.
//
// Measured 2026-08-15: 12 ms for one text, 123 ms for a batch of 40, 1024
// dimensions. Re-measured 2026-08-16 through the shared client: 72 ms for one
// text cold, same dimensions.
//
// The vector HTTP lives in lib/llm.js. This file previously defaulted to
// `http://localhost:8005`, which is the defect the shared client exists to
// remove — it works on one host because haproxy runs there and dies quietly
// anywhere else. `/tokenize` and `/v1/models` are llama.cpp endpoints with no
// registry role of their own, so their host is DERIVED from the embed role's URL
// rather than written down a second time. There is no host literal in this file.
//
// Three endpoints on one origin now: the vectors, the tokenizer, and the model
// probe that gives `embed_model` a MODEL half instead of only a service one.
// Probed 2026-08-17: GET /v1/models returns one entry, id `bge-m3`,
// `meta.n_embd` 1024.
//
// The per-vector shape check below now overlaps the client, as of @axoquant/llm
// 0.3.0 (github:axoquant/llm#6e267b6), which validates the embeddings response
// itself. It stays anyway, for the reason lib/rerank.js's equivalent stays: a
// consumer that trusts a shared client completely is one version pin away from
// the bug it was written to survive, and this file is pinned by commit, so a
// downgrade is an edit to package.json rather than an event anyone would notice.
//
// Keeping it cost something, and the cost was paid rather than waved at. The
// client validating first made the MISSING-vector half of that check unreachable
// through the `fetch` stub every test of it used, and an unreachable guard is one
// nobody can prove works. It is now reached by replacing the client's exported
// embed() through a resolve hook, in test/embed-guard.test.js — which is what
// found that the check was written with `.forEach()` and had therefore never been
// able to see a hole at all. test/embed.test.js keeps the `fetch` stub for the
// model probe, which is parallax's own request and which the client has no
// equivalent of, and for the two halves the client still lets through: a
// wrongly sized vector, and how a refusal raised by the CLIENT gets classified.

import { embed as embedTexts, embedEndpoint } from './llm.js';

const DEFAULT_APP = 'parallax/embed';
const DEFAULT_TIMEOUT_MS = 30_000;

export const EMBED_DIM = 1024;

export class EmbedUnavailable extends Error {
  constructor(detail) {
    super(`embedder unavailable: ${detail}`);
    this.name = 'EmbedUnavailable';
    this.unavailable = true;
    // Named, so the malformed state below is a different VALUE of one field
    // rather than the absence of a field. `.unavailable` alone cannot carry the
    // distinction: both states set it, deliberately, so both degrade.
    this.reason = 'transport';
  }
}

/**
 * A REACHABLE embedder that answered with something the contract does not
 * allow: a component that is not a number, an `index` outside the batch, fewer
 * embeddings than inputs.
 *
 * `.unavailable` as well, and that is not an oversight — lib/corpus/search.js:80
 * and lib/ontology/profiles.js:223 both degrade on that tag, and a nonsense answer
 * must degrade exactly as an outage does rather than 500 the request. What
 * changes is the OPERATOR SIGNAL: the log line is the only thing that says
 * whether to go and look at a service, and this one is up and answering.
 */
export class EmbedMalformed extends Error {
  constructor(detail) {
    super(`embedder malformed response: ${detail}`);
    this.name = 'EmbedMalformed';
    this.unavailable = true;
    this.malformed = true;
    this.reason = 'malformed-response';
  }
}

// Same host as the vectors, by construction. If the embed role moves, the
// tokenizer moves with it and nothing here needs editing.
const tokenizerUrl = async () => `${(await embedEndpoint()).origin}/tokenize`;

/**
 * More than one model behind the embed role. Named, and deliberately NOT
 * `.unavailable`: llama.cpp serves one model per port, so a second entry means
 * the assumption `service:model` rests on has broken. Picking `data[0]` here
 * would put two embedding spaces behind one identifier, which is the defect the
 * composed identifier exists to prevent.
 */
export class EmbedModelAmbiguous extends Error {
  constructor(ids) {
    super(
      `the embed role serves ${ids.length} models (${ids.join(', ')}), so no single ` +
        'model identity describes its vectors; one model per endpoint is the assumption ' +
        'embed_model = service:model rests on'
    );
    this.name = 'EmbedModelAmbiguous';
    this.ambiguous = true;
  }
}

/**
 * A reachable server whose model list cannot name one model. Not
 * `.unavailable` for the same reason the dimension error below is not:
 * degrading past it writes vectors under an embed_model of `service:undefined`,
 * which is a foreign embedding space wearing a plausible label.
 */
export class EmbedModelUnidentifiable extends Error {
  constructor(detail) {
    super(`the embed role did not report an identifiable model: ${detail}`);
    this.name = 'EmbedModelUnidentifiable';
    this.unidentifiable = true;
  }
}

// Same origin as the vectors, derived exactly as `tokenizerUrl` above derives
// the tokenizer. No new host literal enters this file, and if the embed role
// moves, the probe moves with it.
const modelsUrl = async () => `${(await embedEndpoint()).origin}/v1/models`;

let modelProbe = null;

/** Test seam. Same shape as lib/schema/apply.js's `_resetApplied`. */
export function _resetModelProbe() {
  modelProbe = null;
}

async function probeServedModel({ timeoutMs, app }) {
  const url = await modelsUrl();
  let body;
  try {
    const res = await fetch(url, {
      headers: { 'X-Algolotl-App': app },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    body = await res.json();
  } catch (err) {
    // Transport only. A host that is down is the same condition as an
    // unreachable embedder — the callers that degrade to lexical retrieval
    // degrade on `.unavailable` and should degrade here too. Everything BELOW
    // this catch is a malformed answer from a reachable server, which is a
    // defect rather than an outage and must not degrade.
    throw new EmbedUnavailable(err?.cause?.code || err.message);
  }
  const entries = body?.data;
  if (!Array.isArray(entries)) {
    throw new EmbedModelUnidentifiable(`${url} returned no \`data\` array`);
  }
  if (entries.length === 0) {
    throw new EmbedModelUnidentifiable(`${url} returned an empty model list`);
  }
  if (entries.length > 1) {
    throw new EmbedModelAmbiguous(entries.map((e, i) => e?.id ?? `<entry ${i} with no id>`));
  }
  const id = entries[0]?.id;
  if (typeof id !== 'string' || id === '') {
    throw new EmbedModelUnidentifiable(
      `the single entry from ${url} has no usable \`id\` (got ${JSON.stringify(id)})`
    );
  }

  // The third drift direction. test/embed.test.js pins EMBED_DIM against the DDL
  // in both directions; nothing pinned either against the SERVER, which is the
  // only one of the three that actually produces vectors. `meta.n_embd` is what
  // it serves.
  //
  // Degrades to NOT CHECKING when the field is absent rather than to failing:
  // this guard is an extra, `meta` is a llama.cpp shape this repo does not own,
  // and the per-vector length check in `embed` below still rejects a wrong
  // dimension one step later. Failing closed on a renamed upstream field would
  // turn a working embedder into a total outage.
  const served = entries[0]?.meta?.n_embd;
  if (typeof served === 'number' && served !== EMBED_DIM) {
    const err = new Error(
      `the embed role serves ${id} at ${served} dimensions while this build is built for ` +
        `${EMBED_DIM} (EMBED_DIM, and the VECTOR(${EMBED_DIM}) columns in lib/schema/semantic.sql). ` +
        'Mixed dimensions in one vector column cannot be migrated, only regenerated.'
    );
    // Same tag and the same reasoning as the per-vector check in `embed`: a wrong
    // dimension is a real defect, and degrading past it writes unusable vectors
    // rather than stopping.
    err.dimension = true;
    throw err;
  }
  return id;
}

/**
 * The `service:model` identity written to `chunks.embed_model` and
 * `entity_profiles.embed_model`, and bound to the dense leg's predicate.
 */
async function servedModel(opts) {
  // Cached as the PROMISE, so a batch of concurrent embed calls shares one probe
  // rather than each issuing its own. Evicted on failure: a cache that stored the
  // rejection would make one refused connection permanent for the life of the
  // process, and the embedder would come back while parallax did not.
  //
  // KNOWN LIMITATION, stated plainly rather than papered over: an in-place model
  // swap under a RUNNING parallax process is not noticed until restart. Vectors
  // written after such a swap carry the previous model's identity and land in the
  // same embedding space as a matter of luck. This is strictly better than
  // today's behaviour, where the swap is never noticed at all — but it is a real
  // gap, and closing it needs either a re-probe on some interval or an ingest
  // that re-probes per batch, both of which trade a round trip per call for it.
  if (!modelProbe) {
    modelProbe = probeServedModel(opts).catch((err) => {
      modelProbe = null;
      throw err;
    });
  }
  return modelProbe;
}

/**
 * Embed a batch. Returns vectors in INPUT order, the service that produced them,
 * and the `embedModel` identity to record against them.
 *
 * `embedModel` is `service:model` — `bge_8005:bge-m3`. The service alone is a
 * SERVING ENDPOINT, not a model, so it is not an embedding-space identity: the
 * same registry service re-pointed at a different 1024-dimension model keeps the
 * same service string, and anything comparing vectors on that basis compares two
 * spaces without erroring. The model half comes from the embedder's own
 * /v1/models rather than being written down here, so it cannot go stale
 * independently of what is serving — which is why the registry carries no model
 * field and why this does not add one.
 *
 * WHERE THIS PROPERLY BELONGS, AND NOW IS: @axoquant/llm. Up to 0.2.1 it
 * hardcoded `model: 'bge-m3'` in its request body and discarded the `model` the
 * response reported, which is the same value this file spends a round trip to
 * fetch. 0.3.0 (github:axoquant/llm#6e267b6) returns it:
 * `embedWithModel(texts, opts)` gives `{vectors, model}`, from the embeddings
 * response itself.
 *
 * THE PROBE STAYS, and this is now a decision rather than a deferral. It was
 * re-examined on 2026-08-18 against the pinned client and the answer did not
 * change, for four reasons, the first of which is on its own sufficient:
 *
 *   1. The two values are NOT the same value. The probe reads `data[0].id` from
 *      GET /v1/models; `embedWithModel()` reads `data.model` off the embeddings
 *      response, a different field of a different endpoint, and the client sends
 *      `model: 'bge-m3'` in that request as a HINT it does not check the reply
 *      against. Measured 2026-08-18: given an embeddings body naming
 *      `wrong-model`, `embedWithModel()` returns `"wrong-model"` verbatim.
 *      test/embed.test.js already ships exactly that body — the wrong-dimension
 *      fixture pairs `model: 'wrong-model'` with a probe answering `bge-m3` —
 *      so a cutover would silently change embed_model under a fixture that is
 *      in the tree today. Nothing here has measured the two equal on one host, and
 *      the literal `bge_8005:bge-m3` is pinned by test/embed.test.js.
 *   2. It returns null, not an error, when the response names no model —
 *      measured, for both an absent field and an empty string. A cutover has to
 *      decide what `bge_8005:null` means before it can be written to a column.
 *   3. EmbedModelAmbiguous has no equivalent. A single `model` string cannot
 *      report that the endpoint is serving two.
 *   4. `meta.n_embd` has no equivalent either, and the probe runs BEFORE the
 *      embed call, so a server that disagrees with EMBED_DIM costs nothing and
 *      writes nothing.
 *
 * The cost of being wrong here is not symmetric, which is what settles it:
 * embed_model is the dense leg's predicate, and mixed embedding spaces in one
 * vector column cannot be migrated, only regenerated. One cached round trip per
 * process is the cheaper side of that trade.
 *
 * An empty batch returns no `embedModel`: there are no vectors to attribute, and
 * probing would cost a round trip to label nothing. A caller that bound the
 * absent value to `embed_model = $n` would match no row, which is the safe
 * direction — an over-broad match is what this identity exists to prevent.
 */
export async function embed(texts, { timeoutMs = DEFAULT_TIMEOUT_MS, app = DEFAULT_APP } = {}) {
  if (!texts || texts.length === 0) return { vectors: [], service: undefined };
  const { service } = await embedEndpoint();

  // Probed BEFORE the vectors, so a server that disagrees with EMBED_DIM or
  // cannot be identified costs nothing and writes nothing.
  const embedModel = `${service}:${await servedModel({ timeoutMs, app })}`;

  let vectors;
  try {
    vectors = (await embedTexts(texts, { app, timeoutMs })).vectors;
  } catch (err) {
    // A contract break the CLIENT caught is still a contract break, and it is
    // not an outage. @axoquant/llm 0.3.0 raises MalformedResponse for a missing
    // `data` array, an index outside the batch, a duplicate index, an embedding
    // that is not an array, a non-finite component and a short list, and tags
    // every one of them `.malformed`; before 0.3.0 none of those existed and
    // everything arriving here really was transport.
    //
    // Switched on the own property, not on `instanceof MalformedResponse`. Next
    // bundles per route, so a class identity duplicated across bundles makes
    // `instanceof` answer false for an error raised by the same source file —
    // silently, and in the direction of misreporting every malformed payload as
    // an embedder outage. lib/errors.js brands DisclosableError by own property
    // for exactly this reason, lib/rerank.js does the same for the same client,
    // and the client documents the tag as the supported seam. `=== true` so a
    // driver error carrying an unrelated truthy `malformed` field cannot claim
    // the classification.
    if (err?.malformed === true) throw new EmbedMalformed(err.message);
    throw new EmbedUnavailable(err?.cause?.code || err.message);
  }

  // A vector of the wrong LENGTH, or no vector at all, must not reach the
  // database. Postgres would reject it at insert, but by then the chunk row has
  // been written and the failure is attributed to the wrong layer.
  //
  // WHAT THIS OWNS AFTER @axoquant/llm 0.3.0, stated exactly rather than
  // generally. The client now validates every COMPONENT, refuses an embedding
  // that is not an array, an index outside the batch, a duplicate index and a
  // short list — so under the pinned version it hands back a dense array of
  // arrays of finite numbers, and the only property left that can be wrong is
  // the LENGTH. That one is this file's, and should be: 1024 comes from the
  // VECTOR(1024) columns in lib/schema/semantic.sql, which is this project's
  // fact and not the client's, and the client has no opinion about it.
  //
  // Kept AND reachable, which is the part that is not free. The dimension case
  // is still driven through a `fetch` stub in test/embed.test.js, because the
  // client passes a wrongly sized array straight through. A MISSING vector is
  // not reachable that way any more — measured 2026-08-18, ten bodies that would
  // produce one were all refused by the client's readVectors() first — so
  // test/embed-guard.test.js replaces the client's exported embed() through a
  // `node:module` resolve hook and drives it in directly. Without that seam this
  // would be an untested guard with a comment claiming it protects something,
  // and the honest choice would have been to delete it.
  //
  // A PLAIN INDEXED LOOP, not `.forEach()`, and this is not style. This was
  // `vectors.forEach(...)` until the seam above reached it, and .forEach() SKIPS
  // HOLES: a sparse result array — a client that wrote some positions and not
  // others, which is precisely what the optional chaining in `v?.length` is
  // written to catch — was never handed to the callback at all, so the guard
  // passed it silently and `undefined` went on to be joined into a VECTOR
  // literal. lib/rerank.js's equivalent loop is indexed for the same reason.
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (v?.length !== EMBED_DIM) {
      const err = new Error(
        `embedding for input ${i} has the wrong shape: expected ${EMBED_DIM} dimensions, got ${v?.length}`
      );
      // Deliberately NOT `.unavailable`: a wrong dimension is a real defect, and
      // degrading past it would write unusable vectors rather than stopping.
      err.dimension = true;
      throw err;
    }
  }

  return { vectors, service, embedModel };
}

export async function countTokens(text, { timeoutMs = DEFAULT_TIMEOUT_MS, app = DEFAULT_APP } = {}) {
  try {
    const url = await tokenizerUrl();
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Algolotl-App': app },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const data = await res.json();
    return (data?.tokens || []).length;
  } catch (err) {
    throw new EmbedUnavailable(err?.cause?.code || err.message);
  }
}
