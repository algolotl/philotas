// lib/ontology/profiles.js
//
// Entity profiles: one row per known entity, carrying the text that describes it
// and the vector that text embeds to. This is the index a span resolves against
// and the thing candidate generation searches.
//
// WHAT GOES IN A PROFILE, AND WHY IT MATTERS.
//
// entity_profiles has no case_id and is read by every case on the deployment.
// The spec describes profile_text as "attributes + confirmed mentions"; in this
// increment it is attributes ONLY. A confirmed mention drawn from an uploaded
// case document would put one tenant's sentence into a table every other tenant
// searches, and the scope predicate on `chunks` would not help, because the leak
// would be in a table that has no scope column at all. Mentions get added when
// there is a mechanism that keeps them case-scoped, and not before.
//
// The text is built in a fixed attribute order so that "the profile changed"
// means the entity changed, not that a feed serialised its JSON differently.
// Without that, every poll re-embeds every entity.
//
// WHAT `embed_model` HAS TO BE, AND WHY IT COSTS A ROUND TRIP.
//
// The identity written here is `service:model` — `bge_8005:bge-m3` — and it comes
// from lib/embed.js, which reads the model half from the embedder's own
// /v1/models. The registry SERVICE alone is a serving endpoint, not an embedding
// space: re-pointing the same service at a different 1024-dimension model is a
// routine in-place upgrade, and a stored identity of `bge_8005` would not change
// across it. One predicate would then match two incompatible spaces, and cosine
// distance across them does not error — it returns confident nonsense. EMBED_DIM
// cannot catch it, because both models are 1024.
//
// That has a consequence this module has to live with. `embed([])` deliberately
// returns no `embedModel` (there are no vectors to attribute), so the only way to
// learn which space the STORED vectors belong to is to embed something. When
// profile text has changed there is something to embed anyway and the identity
// comes free with the first batch. When nothing has changed, one profile text is
// sent purely to establish the identity — the price of being able to notice that
// every stored vector is now in a retired space. Mixed spaces in one vector
// column cannot be migrated, only regenerated, which is what makes that price
// worth paying every refresh interval rather than discovering it at re-index
// time.

import { embed } from '../embed.js';

const APP = 'parallax/profiles';

// How many profile texts go to the embedder in one request. Measured through the
// shared client on 2026-08-16: 123 ms for a batch of 40, 72 ms for one text cold,
// so the round trip dominates and batching is most of the win. 32 keeps a batch
// inside the embed role's max_concurrency of 8 with room for concurrent callers.
export const PROFILE_BATCH_SIZE = 32;

// Attributes worth describing an entity by, in the order they are written.
// Deliberately a list rather than "everything in props": feed payloads carry
// timestamps and positions that change every poll, and including them would mark
// every entity as changed on every pass.
const PROFILE_ATTRIBUTES = [
  'ship_type', 'vessel_type', 'destination', 'operator', 'berth', 'terminal',
  'mode', 'route', 'agency', 'category', 'status', 'country', 'mmsi', 'imo',
  'norad', 'callsign', 'radius_metres',
];

// Attributes that are identifiers rather than descriptions. These become aliases
// so the trigram leg can match "IMO 9776171" in a document.
//
// `id` is deliberately absent. A feed's own row id is an internal handle — a
// slug or a sequence number — and no document says it, so aliasing it buys
// nothing and trigram-matches unrelated digits in real text. The entity's
// top-level `id` is worse still: induce() builds it as `feed:label`, which
// appears in no source anywhere.
const IDENTIFIER_ATTRIBUTES = ['mmsi', 'imo', 'norad', 'callsign', 'code'];

const scalar = (v) => v != null && (typeof v === 'string' || typeof v === 'number');

/**
 * `Type:Label`. The same shape lib/corpus/service.js builds for corpus_entities —
 * two conventions for one key would mean the two tables never describe the same
 * entity.
 */
export function entityKeyFor(entity) {
  return `${entity.type}:${entity.label}`;
}

export function profileTextFor(entity) {
  // `?? ''` rather than interpolating directly: induce() synthesises a label for
  // every entity it produces, but a caller that does not would otherwise write
  // the literal string "undefined" into a profile and embed it.
  const lines = [`${entity.type}: ${entity.label ?? ''}`.trimEnd()];
  for (const key of PROFILE_ATTRIBUTES) {
    const value = entity.props?.[key];
    if (!scalar(value)) continue;
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

export function aliasesFor(entity) {
  const label = String(entity.label ?? '');
  const out = [];
  for (const key of IDENTIFIER_ATTRIBUTES) {
    const value = entity.props?.[key];
    if (!scalar(value)) continue;
    const text = String(value);
    if (text === label || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

const UPSERT = `INSERT INTO entity_profiles
           (entity_key, entity_type, label, aliases, profile_text, embedding, embed_model, updated_ms)
         VALUES ($1,$2,$3,$4,$5,$6::vector,$7,$8)
         ON CONFLICT (entity_key) DO UPDATE SET
           entity_type  = EXCLUDED.entity_type,
           label        = EXCLUDED.label,
           aliases      = EXCLUDED.aliases,
           profile_text = EXCLUDED.profile_text,
           embedding    = EXCLUDED.embedding,
           embed_model  = EXCLUDED.embed_model,
           updated_ms   = EXCLUDED.updated_ms`;

/**
 * Write profiles for the given induced entities.
 *
 * Embeds only what changed: the profile text differs from what is stored, or the
 * stored vector came from a different embedding space. Returns counts and a named
 * degradation rather than throwing, because a profile pass is background work and
 * an unreachable embedder must not take the caller down.
 *
 * FIVE COUNTERS, AND WHAT EACH ONE MEANS. They disagree on purpose: a caller
 * reading only `written` cannot tell "nothing needed doing" from "everything
 * failed", and those need different responses.
 *
 *   considered  distinct entities examined. Duplicates and entities with no type
 *               or label are not counted, because nothing was decided about them.
 *   changed     profiles whose stored state does not match what this pass would
 *               write: no row, different text, or a vector from another embedding
 *               space. With the embedder unreachable the space is unknowable, so
 *               this falls back to the text difference alone — still the honest
 *               "work outstanding" number, and never zero merely because nothing
 *               could be done about it.
 *   embedded    profile texts a vector came back for. Exceeds `changed` by one on
 *               a pass where nothing had textually changed: that one is the
 *               identity probe described at the head of this file, whose vector is
 *               discarded when the profile it belongs to turns out to be current.
 *   written     rows the database accepted.
 *   degraded    comma-joined named signals in the order the stages produced them,
 *               or null. Never a boolean: `no-embedder` and `no-profile-write` are
 *               a missing model server and a broken table, and an operator told
 *               only "true" would have to guess which. Accumulated rather than
 *               assigned, the same discipline as lib/corpus/search.js, so a second
 *               failure does not bury the first.
 *
 * A failed READ throws: nothing can be decided about any profile without it, so
 * there is no partial result to report. A failed WRITE degrades by name and the
 * pass continues, because one rejected row must not cost the other ninety-nine
 * their profiles — the gap between `changed` and `written` is what says how many
 * were lost.
 */
export async function upsertEntityProfiles(pool, entities, { batchSize = PROFILE_BATCH_SIZE } = {}) {
  const unique = new Map();
  for (const entity of entities || []) {
    if (!entity?.type || !entity?.label) continue;
    unique.set(entityKeyFor(entity), entity);
  }
  const considered = unique.size;
  // Nothing to embed means nothing is sent to the embedder AT ALL. An empty batch
  // reports no `embedModel`, and a row written under that absent value would be
  // labelled `undefined` — a foreign embedding space wearing a plausible label,
  // which is exactly what the composed identity exists to prevent.
  if (considered === 0) return { considered: 0, changed: 0, embedded: 0, written: 0, degraded: null };

  const keys = [...unique.keys()];
  const stored = await pool.query(
    `SELECT entity_key, profile_text, embed_model FROM entity_profiles WHERE entity_key = ANY($1)`,
    [keys]
  );
  const existing = new Map((stored?.rows || []).map((row) => [row.entity_key, row]));

  const pending = keys.map((key) => {
    const entity = unique.get(key);
    const profileText = profileTextFor(entity);
    const prior = existing.get(key);
    return {
      key,
      entity,
      profileText,
      textChanged: !prior || prior.profile_text !== profileText,
      // NULL included on purpose: a row whose vector cannot be attributed to a
      // model is not a reusable vector, whatever its text says.
      priorModel: prior?.embed_model ?? null,
    };
  });

  const degradedSignals = [];
  const signal = (name) => { if (!degradedSignals.includes(name)) degradedSignals.push(name); };
  const degraded = () => (degradedSignals.length > 0 ? degradedSignals.join(',') : null);

  const vectored = new Map();   // entity_key -> { vector, embedModel }
  let embedded = 0;
  let written = 0;
  const now = Date.now();

  // The identity of the live embedding space, and the first batch of real work in
  // the same round trip whenever there is any. Only when nothing has textually
  // changed does a text go purely to establish the identity.
  const textChanged = pending.filter((p) => p.textChanged);
  const opening = textChanged.length > 0 ? textChanged.slice(0, batchSize) : pending.slice(0, 1);
  let liveModel;
  try {
    const result = await embed(opening.map((p) => p.profileText), { app: APP });
    liveModel = result.embedModel;
    // Each vector carries the identity reported by the call that produced it,
    // rather than one identity applied to the whole pass. A model swapped between
    // two batches would otherwise label the later vectors with the earlier space.
    opening.forEach((p, n) => vectored.set(p.key, { vector: result.vectors[n], embedModel: result.embedModel }));
    embedded += opening.length;
  } catch (err) {
    // `.unavailable` only. An embedder that is reachable but serves two models, or
    // cannot name the one it serves, or serves the wrong dimension, is a defect
    // rather than an outage: degrading past it writes vectors under a guessed
    // identity, which is worse than writing none. Those propagate.
    if (!err?.unavailable) throw err;
    return {
      considered,
      // The text difference is knowable without the embedder; the embedding space
      // is not. This is the outstanding work, not a claim that nothing changed.
      changed: textChanged.length,
      embedded: 0,
      written: 0,
      degraded: 'no-embedder',
    };
  }

  const stale = pending.filter((p) => p.textChanged || p.priorModel !== liveModel);
  const changed = stale.length;

  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize);
    const toEmbed = batch.filter((p) => !vectored.has(p.key));
    if (toEmbed.length > 0) {
      try {
        const result = await embed(toEmbed.map((p) => p.profileText), { app: APP });
        toEmbed.forEach((p, n) => vectored.set(p.key, { vector: result.vectors[n], embedModel: result.embedModel }));
        embedded += toEmbed.length;
      } catch (err) {
        if (!err?.unavailable) throw err;
        // An embedder that has gone is gone for the batches after this one too;
        // retrying each would cost a round trip apiece to learn the same thing.
        signal('no-embedder');
        break;
      }
    }

    for (const p of batch) {
      const ready = vectored.get(p.key);
      // No vector, no row. This batch is drawn from `stale`, so the only profile
      // reachable here without one is a profile the embedder never answered for —
      // and a row with no vector is worse than no row: invisible to the dense leg,
      // present to the trigram one, silently asymmetric. (The opening batch's
      // probe profile, when it turns out to be current, is absent from `stale`
      // altogether and its vector is simply discarded.)
      if (!ready) continue;
      try {
        const result = await pool.query(UPSERT, [
          p.key, p.entity.type, p.entity.label, aliasesFor(p.entity), p.profileText,
          `[${ready.vector.join(',')}]`, ready.embedModel, now,
        ]);
        written += result?.rowCount ?? 1;
      } catch {
        // Named rather than swallowed, and not fatal: a caller has to be able to
        // tell "nothing needed writing" from "the writes were refused".
        signal('no-profile-write');
      }
    }
  }

  return { considered, changed, embedded, written, degraded: degraded() };
}
