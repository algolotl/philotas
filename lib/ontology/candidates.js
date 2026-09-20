// lib/ontology/candidates.js
//
// Which entities a chunk might be talking about.
//
// Two generators here, unioned and deduplicated by (chunk, entity):
//
//   profile-similarity  nearest entity profiles to the chunk embedding, by
//                       EXACT cosine. Spec section 5.2: the profile table is a
//                       few thousand rows (1,936 measured on the deployed
//                       Sydney instance, 2026-08-15) and carries no HNSW index,
//                       because the spec measured an exact scan inside a scope
//                       at 1.9 ms for 200 rows and 23 ms for 3,000, against
//                       777 MB per 100,000 rows for the index.
//
//   trigram             pg_trgm between entity labels and aliases and the chunk
//                       text. This catches the exact and near-exact names the
//                       embedding ranks low — a long chunk's embedding is
//                       dominated by its subject, and a name mentioned once in
//                       passing barely moves it.
//
// The third generator in the spec, deterministic spatial and identifier
// matching, is not here: it produces links directly with
// method: 'deterministic' and is never scored by a model. It lives in
// lib/ontology/build.js and stays there.
//
// NO CASE SCOPE, DELIBERATELY. entity_profiles has no case_id — it is the
// deployment's shared index of known entities, and lib/ontology/profiles.js
// keeps case-derived text out of it for exactly that reason. The chunk being
// searched is the scoped thing, and its scope was applied by whoever fetched it.
//
// WHY word_similarity AND NOT similarity. similarity() compares two whole
// strings, so a 512-token chunk against a 14-character label scores near zero
// and the leg would never fire. word_similarity(label, chunk) scores the label
// against the best-matching run of words INSIDE the chunk, which is the
// question actually being asked. The threshold below is pg_trgm's own
// documented default for word similarity; it is **assumed** for this use, not
// measured, and belongs in the calibration set once there is one.
//
// FOUR RETURN FIELDS, AND WHY EACH IS SEPARATELY OBSERVABLE.
//
//   candidates  the merged, ranked union.
//   generators  how many rows each leg PROPOSED, before dedup and before the
//               cap. This is what makes the overlap visible: two legs proposing
//               one row each for one candidate means the union deduplicated
//               one, and a reader of `candidates` alone cannot see that. It is
//               also, with `degraded`, what separates "the trigram leg found
//               nothing" (0 and no signal) from "the trigram leg failed" (0 and
//               `no-trigram`) — the same two states that read identically in
//               the ontology route until Task 3 pinned them apart.
//   dropped     what an applied cap took. Paired with the cap on purpose: a
//               truncated result with no count reads as a complete one, which
//               is precisely what the slice(0, 40) this replaces did.
//   degraded    comma-joined named signals in the order the stages produced
//               them, or null. Never a boolean — `no-profile-similarity` and
//               `no-trigram` are a missing model server and a broken pg_trgm,
//               and an operator told only "true" has to guess which.
//               Accumulated rather than assigned, the same discipline as
//               lib/corpus/search.js, so a second failure does not bury the
//               first.

import { embed, EMBED_DIM } from '../embed.js';

const APP = 'philotas/candidates';

export const PROFILE_SIMILARITY_TOP_K = 20;   // **assumed**, per spec section 5.2
export const TRIGRAM_TOP_K = 20;              // **assumed**
export const TRIGRAM_MIN_WORD_SIMILARITY = 0.6; // pg_trgm's documented default; **assumed** here

// embed_model is pinned rather than filtered afterwards, for the same reason
// lib/corpus/search.js pins it on `chunks`: a vector from another model is not a
// distant neighbour, it is a number with no meaning, and cosine distance across
// two embedding spaces does not error — it returns confident nonsense. EMBED_DIM
// cannot catch it, because two 1024-dimension models are two spaces of the same
// width. Exact distance, no index — see the module comment.
const PROFILE_SQL = `SELECT entity_key, entity_type, label, embedding <=> $1::vector AS distance
     FROM entity_profiles
    WHERE embedding IS NOT NULL AND embed_model = $2
    ORDER BY embedding <=> $1::vector
    LIMIT $3`;

// The label AND every alias, scored against the best-matching run of words in
// the chunk, keeping the better of the two. GREATEST over a scalar subquery
// rather than a join, so an entity with eight aliases is still one row and the
// LIMIT still means what it says.
const TRIGRAM_SQL = `SELECT entity_key, entity_type, label, word_similarity
     FROM (
       SELECT entity_key, entity_type, label,
              GREATEST(
                word_similarity(label, $1),
                COALESCE((SELECT MAX(word_similarity(alias, $1)) FROM unnest(aliases) AS alias), 0)
              ) AS word_similarity
         FROM entity_profiles
     ) scored
    WHERE word_similarity >= $2
    ORDER BY word_similarity DESC
    LIMIT $3`;

/**
 * A caller-supplied vector never passes through lib/embed.js's checks, so it is
 * checked here and nowhere else.
 *
 * A PLAIN INDEXED LOOP, not `.forEach()`, and this is not style. `.forEach()`
 * SKIPS HOLES: a sparse array — some positions written and others never assigned
 * — is never handed to the callback at all, so a guard written under it passes
 * the array silently and `undefined` goes on to be joined into a pgvector
 * literal as `[0.02,,0.02]`. That is the defect found in lib/embed.js on
 * 2026-08-17, where the same guard had never once been able to see a hole.
 */
function assertUsableVector(vector) {
  if (!Array.isArray(vector)) {
    const err = new Error(`the chunk embedding is not an array (got ${typeof vector})`);
    err.dimension = true;
    throw err;
  }
  if (vector.length !== EMBED_DIM) {
    const err = new Error(
      `the chunk embedding has the wrong shape: expected ${EMBED_DIM} dimensions, got ${vector.length}. ` +
        `${EMBED_DIM} comes from the VECTOR(${EMBED_DIM}) columns in lib/schema/semantic.sql.`
    );
    // Deliberately NOT `.unavailable`. A malformed vector from a caller is a
    // defect, and degrading past it searches with a literal Postgres will reject
    // — attributing the fault to the database rather than to whoever built it.
    err.dimension = true;
    throw err;
  }
  for (let i = 0; i < vector.length; i++) {
    const component = vector[i];
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      const err = new Error(
        `the chunk embedding's component ${i} is not a finite number (got ${JSON.stringify(component) ?? 'a hole'})`
      );
      err.dimension = true;
      throw err;
    }
  }
}

export async function generateCandidates(pool, {
  chunkId,
  chunkText = null,
  chunkEmbedding = null,
  chunkEmbedModel = null,
  profileTopK = PROFILE_SIMILARITY_TOP_K,
  trigramTopK = TRIGRAM_TOP_K,
  minWordSimilarity = TRIGRAM_MIN_WORD_SIMILARITY,
  cap = null,
} = {}) {
  // A stored vector belongs to the embedding space its own row's embed_model
  // names, which is not necessarily the space the embedder serves today. The two
  // available wrong answers are both silent: bind the live identity and compare
  // two spaces, or bind nothing and match no row while reading as "no similar
  // profiles". Each direction below says which half is missing.
  if (chunkEmbedding && !chunkEmbedModel) {
    throw new Error(
      'chunkEmbedding was given without chunkEmbedModel: a vector with no embedding-space identity ' +
        'cannot be given a predicate, and searching it against the live identity compares two spaces'
    );
  }
  if (chunkEmbedModel && !chunkEmbedding) {
    throw new Error(
      'chunkEmbedModel was given without chunkEmbedding: naming a space with no vector to search it ' +
        'with would silently embed the chunk text and search that instead'
    );
  }
  if (chunkEmbedding) assertUsableVector(chunkEmbedding);

  const hasText = typeof chunkText === 'string' && chunkText.trim() !== '';
  const generators = { 'profile-similarity': 0, trigram: 0 };
  const degradedSignals = [];
  const signal = (name) => { if (!degradedSignals.includes(name)) degradedSignals.push(name); };
  const degraded = () => (degradedSignals.length > 0 ? degradedSignals.join(',') : null);

  const merged = new Map();
  const add = (row, generator, fields) => {
    const key = `${chunkId}\u0000${row.entity_key}`;
    const existing = merged.get(key) || {
      chunkId,
      entityKey: row.entity_key,
      entityType: row.entity_type,
      label: row.label,
      generators: [],
      // Null, not zero, and the difference is load-bearing: 0 is a real cosine
      // and a real word similarity, and a candidate the other leg never saw has
      // neither. Anything ranking or thresholding these has to be able to tell.
      cosineSimilarity: null,
      wordSimilarity: null,
    };
    if (!existing.generators.includes(generator)) existing.generators.push(generator);
    Object.assign(existing, fields);
    merged.set(key, existing);
    generators[generator] += 1;
  };

  // Indexed, and guarded. A row with no entity_key would merge under the key
  // `chunkId\0undefined` and collide with every other such row, producing one
  // candidate for an entity that does not exist.
  const absorb = (rows, generator, fieldsFor) => {
    const list = rows || [];
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (!row?.entity_key) continue;
      add(row, generator, fieldsFor(row));
    }
  };

  if (!hasText && !chunkEmbedding) {
    // Nothing to search with at all. Not an error and not an empty success: a
    // chunk with no text was never extracted, and that has to be distinguishable
    // from a chunk whose text matched nothing.
    signal('no-chunk-text');
    return { candidates: [], generators, dropped: 0, degraded: degraded() };
  }

  // --- profile similarity -------------------------------------------------
  try {
    let vector = chunkEmbedding;
    let embedModel = chunkEmbedModel;
    if (!vector) {
      // `embedModel` and NOT `service`. The registry service is a SERVING
      // ENDPOINT: re-pointing it at a different 1024-dimension model is a routine
      // in-place upgrade that leaves the service string unchanged, so a predicate
      // bound to it matches two spaces at once. lib/embed.js composes
      // `service:model` by reading the model half from the embedder's own
      // /v1/models. Nothing here validates the returned vector — lib/embed.js
      // checks every one it hands back, with an indexed loop, and duplicating
      // that would be a second copy to drift.
      const result = await embed([chunkText], { app: APP });
      vector = result.vectors[0];
      embedModel = result.embedModel;
    }
    const literal = `[${vector.join(',')}]`;
    const dense = await pool.query(PROFILE_SQL, [literal, embedModel, profileTopK]);
    absorb(dense?.rows, 'profile-similarity', (row) => ({ cosineSimilarity: 1 - Number(row.distance) }));
  } catch (err) {
    // `.unavailable` only, the same handler shape as lib/corpus/search.js's dense
    // leg. An embedder that is reachable but serves two models, or cannot name
    // the one it serves, or serves the wrong dimension, is a defect rather than
    // an outage: searching past it binds a guessed identity to the predicate and
    // compares two spaces. Those propagate, and so does a SQL fault — a genuinely
    // broken entity_profiles must fail loudly rather than read as a thin result.
    if (!err?.unavailable) throw err;
    // The lexical leg still works, and says so. A caller that treats a
    // trigram-only candidate set as a complete one is a reviewable defect.
    signal('no-profile-similarity');
  }

  // --- trigram ------------------------------------------------------------
  if (!hasText) {
    signal('no-chunk-text');
  } else {
    try {
      const trigram = await pool.query(TRIGRAM_SQL, [chunkText, minWordSimilarity, trigramTopK]);
      absorb(trigram?.rows, 'trigram', (row) => ({ wordSimilarity: Number(row.word_similarity) }));
    } catch {
      // Everything, not only `.unavailable`, and the asymmetry with the leg above
      // is the point. The two legs are independent, and one leg's fault must not
      // throw away the other's work — a chunk with good profile-similarity
      // candidates should not go unlinked because pg_trgm is missing on a managed
      // Postgres that applied the rest of the schema. What must never happen is
      // the failure being invisible, so it is named: an empty result carrying
      // `no-trigram` is a different thing from an empty result carrying nothing,
      // and Task 3 found that exact conflation twice in the ontology route.
      signal('no-trigram');
    }
  }

  // Rank before capping. A cap applied to an unsorted union keeps whichever rows
  // the two legs happened to return first, which is not the same thing as the
  // best candidates and reads identically in the output.
  const ranked = [...merged.values()].sort((a, b) => bestScore(b) - bestScore(a));

  let candidates = ranked;
  let dropped = 0;
  // `cap != null`, not `cap`. A cap of 0 is falsy, and a truthiness test would
  // skip it entirely and return everything as though no cap had been asked for.
  if (cap != null && ranked.length > cap) {
    candidates = ranked.slice(0, cap);
    dropped = ranked.length - cap;
    // Spec section 10: any applied cap emits a count of what it dropped. The
    // slice(0, 40) this replaces dropped candidates with no log line at all.
    console.warn(`[candidates] chunk ${chunkId}: cap ${cap} dropped ${dropped} of ${ranked.length} candidates`);
  }

  return { candidates, generators, dropped, degraded: degraded() };
}

// One comparable number per candidate for ranking only. The two legs produce
// incomparable scales, so this is deliberately a max rather than a blend: the
// real decision is the cross-encoder's, and inventing a fused score here would
// put an unvalidated weighting in front of a calibrated one. A sum would also
// make being found by two legs a score in itself, which is a claim nothing has
// measured.
//
// A missing score is -Infinity rather than 0, for the reason the null above is a
// null: 0 is a real cosine, and a candidate the profile leg never saw has not
// scored 0 against it.
function bestScore(candidate) {
  return Math.max(candidate.cosineSimilarity ?? -Infinity, candidate.wordSimilarity ?? -Infinity);
}
