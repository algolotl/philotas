// Co-mention connections between entities — DETERMINISTIC. No model, ever.
//
// The structured feeds know that a vessel is alongside a berth, because geometry
// says so. They do not know that the vessel, three restaurants and a hospital all
// appear in the same week of public reporting. Nothing joins those records; the
// only thing joining them is that open sources mention them together.
//
// That join is set intersection over the document corpus, and it stays here in
// deterministic code on purpose. The connection is the FINDING. A finding has to
// survive being re-run: same corpus in, same edges out, same numbers, forever.
// Speculation about what a connection MEANS lives in hypothesis.js, is written by
// a model, and is quarantined behind a governor. The two must not be confused,
// so they are not even in the same file.

// ---------------------------------------------------------------- tuning
//
// How many neighbours to pull from the store per entity. We deliberately fetch a
// full set even when returning fewer, because the promiscuity estimate below is
// only as good as the neighbour set it is computed from (see dampening note).
const NEIGHBOUR_FETCH_LIMIT = 40;

// Strength saturation constant. See `strengthFrom`.
const SATURATION_K = 1;

// --- Blow-up guards -------------------------------------------------------
// A hub entity — "Port of Sydney", or a health district that every article about
// the outbreak names — can be connected to hundreds of others. Two hops off a
// hub is a cartesian product, and an unbounded BFS over it will happily issue
// thousands of store queries and return a path list nobody can read. So every
// traversal is bounded three ways: how many neighbours of a node we will even
// look at (fanout), how many nodes we will expand in total (budget), and how
// many results we will accumulate (limit). These are caps, not errors: hitting
// one silently truncates the search, which is the correct behaviour for an
// exploratory tool but means path lists are best-effort, not exhaustive.
const PATH_FANOUT_CAP = 25;
const PATH_EXPANSION_BUDGET = 200;
const CLUSTER_FANOUT_CAP = 12;
const CLUSTER_MAX_NODES = 120;

// ---------------------------------------------------------------- store access
//
// The real store is imported lazily rather than at module load. Callers may
// inject a fake via `options.store`, and when they do — every test in
// test/connections.test.js — no database handle is ever opened, and this module
// can be exercised on a machine with no corpus Postgres at all.
let storeModule = null;
async function resolveStore(injected) {
  if (injected) return injected;
  if (!storeModule) storeModule = await import('./store.js');
  return storeModule;
}

function uniq(list) {
  return [...new Set((list || []).filter((x) => x != null))];
}

function round3(n) {
  // Fixed precision so the same corpus produces byte-identical findings across
  // runs and across machines. Float drift in a number an analyst cites is not
  // acceptable in an audit trail.
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------- strength
//
// STRENGTH, AND WHY IT IS DAMPENED BY DOCUMENT PROMISCUITY.
//
// The naive score is "how many documents do these two share". It is wrong, and
// wrong in a way that manufactures false leads. A port authority bulletin listing
// forty berths, twelve vessels and every terminal operator in the harbour links
// all of them to each other at full weight. A local news story that mentions
// exactly two things — this ship, this restaurant — is far better evidence that
// those two things have something to do with each other, and the naive score
// rates them identically.
//
// So each shared document contributes weight inversely proportional to how many
// entities it mentions:
//
//     w(d) = 1 / (entities_in_d - 1)
//
// A document naming exactly two entities gives the pair weight 1. A document
// naming forty spreads that same single unit of evidence across the 39 pairings
// it implies, so each gets 1/39. This is Newman's co-authorship weighting: a
// two-author paper is strong evidence the authors collaborated, a 400-author
// paper is nearly none, and the total evidence a document can contribute is
// capped at one regardless of how many names it drops.
//
// `entities_in_d` is estimated from the anchor's own neighbourhood: the number of
// the anchor's neighbours that also share d, plus the anchor itself. That is
// exact whenever the store returned the anchor's full neighbour list, and it is
// symmetric — the count of entities in a document does not depend on which of
// them you asked about. It is a LOWER BOUND when the neighbour list was truncated
// at NEIGHBOUR_FETCH_LIMIT, which biases strength UPWARD for hub entities. That
// is the one asymmetry in this file and the reason clusterAround keeps the lower
// of the two directions when it has both.
//
// Pair weight is then summed over shared documents and squashed into 0..1:
//
//     strength = W / (W + 1)
//
// One exclusive two-entity document scores 0.5 — a real signal, not a proof.
// Three of them score 0.75. The curve is asymptotic and never reaches 1, which
// is the honest shape: co-mention is evidence of co-mention. It is never proof
// of a relationship, so no volume of it should ever display as certainty.
function strengthFrom(weight) {
  return round3(weight / (weight + SATURATION_K));
}

// Pure, so the ranking is identical on every call regardless of who asks.
function rankNeighbours(anchorKey, rows, { minShared = 1, limit = 25 } = {}) {
  const clean = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (!row || !row.entity_key) continue;
    // Self-loop guard. An entity always shares every one of its documents with
    // itself; that edge is trivially true and says nothing.
    if (row.entity_key === anchorKey) continue;
    // A duplicated row would double-count both the shared total and the
    // promiscuity estimate, inflating the entity twice over.
    if (seen.has(row.entity_key)) continue;
    seen.add(row.entity_key);

    const documentIds = uniq(row.document_ids);
    if (documentIds.length === 0) continue; // no citable evidence, no edge
    clean.push({
      entity_key: row.entity_key,
      entity_type: row.entity_type ?? null,
      entity_label: row.entity_label ?? null,
      document_ids: documentIds,
    });
  }

  // How many of the anchor's neighbours each shared document also mentions.
  // +1 for the anchor gives the document's entity count.
  const coMentioned = new Map();
  for (const row of clean) {
    for (const id of row.document_ids) coMentioned.set(id, (coMentioned.get(id) || 0) + 1);
  }

  const scored = clean.map((row) => {
    let weight = 0;
    for (const id of row.document_ids) {
      // entities_in_d - 1 === neighbours of the anchor in d, never below 1.
      weight += 1 / Math.max(1, coMentioned.get(id) || 1);
    }
    return {
      ...row,
      // Derived from the ids we can actually cite rather than any count the
      // store reports, so every number on screen has documents behind it.
      shared_documents: row.document_ids.length,
      strength: strengthFrom(weight),
    };
  });

  return scored
    .filter((row) => row.shared_documents >= minShared)
    // Full deterministic ordering. entity_key breaks the final tie so equal
    // edges never swap places between runs.
    .sort((a, b) =>
      b.strength - a.strength ||
      b.shared_documents - a.shared_documents ||
      a.entity_key.localeCompare(b.entity_key))
    .slice(0, Math.max(0, limit));
}

async function fetchRanked(store, entityKey, { minShared, limit }) {
  // Always ask for a full neighbour set even when returning fewer: a truncated
  // list makes documents look less promiscuous than they are and inflates
  // strength. Paying for the extra rows buys an honest denominator.
  const rows = await store.entitiesSharingDocuments(entityKey, Math.max(limit, NEIGHBOUR_FETCH_LIMIT));
  return rankNeighbours(entityKey, rows, { minShared, limit });
}

// ---------------------------------------------------------------- connections

// Entities that share documents with this one, strongest first.
export async function findConnections(entityKey, options = {}) {
  const { minShared = 1, limit = 25, store, includeDocuments = false } = options;
  if (!entityKey) return [];

  const s = await resolveStore(store);
  const ranked = await fetchRanked(s, entityKey, { minShared, limit });
  if (!includeDocuments || ranked.length === 0) return ranked;

  // Opt-in hydration. Ids are what the graph runs on; titles and URLs are what a
  // human needs to judge an edge. Batched into one documentsById call across all
  // neighbours rather than one call each, because a hub would otherwise issue 25
  // queries to render a single panel.
  const wanted = uniq(ranked.flatMap((row) => row.document_ids));
  const docs = await s.documentsById(wanted);
  const byId = new Map((docs || []).map((doc) => [doc.id, doc]));
  return ranked.map((row) => ({
    ...row,
    documents: row.document_ids.map((id) => byId.get(id)).filter(Boolean),
  }));
}

// ---------------------------------------------------------------- paths
//
// Breadth-first over the co-mention graph. This is the function that surfaces
// vessel -> restaurant -> hospital: three entities no database joins, connected
// by two documents that each mention two of them.
//
// BFS (not DFS) because the shortest chain is the one most likely to mean
// something — every extra hop multiplies the ways a chain can be coincidence.
//
// KNOWN LIMITATION, measured rather than assumed. The dampening above is per
// DOCUMENT, so it cannot see a promiscuous ENTITY. A health department or a port
// authority that appears in fifty separate two-entity articles has an exclusive,
// full-weight edge to every one of those fifty things, and a route through it
// scores identically to a genuine vessel -> restaurant -> hospital chain. Both
// come out at weakest_link 0.5. Such a route is true — the co-mentions really
// are there — and close to meaningless, because the intermediary connects
// everything to everything.
//
// Nothing here silently discounts it, because weakest_link is defined as the
// lowest edge strength on the path and quietly redefining a number an analyst
// cites is worse than the limitation itself. The mitigation is at the point of
// use: an intermediary's connection count is one findConnections call away, and
// an interface rendering a path should show it. test/connections.test.js pins
// this behaviour so it cannot be changed by accident.
export async function findPaths(fromKey, toKey, options = {}) {
  const {
    maxHops = 3,
    limit = 10,
    minShared = 1,
    store,
    fanout = PATH_FANOUT_CAP,
    expansionBudget = PATH_EXPANSION_BUDGET,
  } = options;

  // A path from a thing to itself is not a finding.
  if (!fromKey || !toKey || fromKey === toKey) return [];

  const s = await resolveStore(store);

  // Memoised per call: a hub reached from four different directions is fetched
  // once, not four times. Also makes the expansion budget mean what it says.
  const cache = new Map();
  const neighbours = async (key) => {
    if (!cache.has(key)) cache.set(key, await fetchRanked(s, key, { minShared, limit: fanout }));
    return cache.get(key);
  };

  const results = [];
  const seenPaths = new Set();
  let expansions = 0;

  // FIFO queue — index-advanced rather than shifted, so a wide frontier does not
  // turn into quadratic array copying.
  const queue = [{ path: [fromKey], documents: [], strengths: [] }];
  let head = 0;

  while (head < queue.length && results.length < limit && expansions < expansionBudget) {
    const state = queue[head++];
    if (state.path.length - 1 >= maxHops) continue; // no budget left to extend

    expansions += 1;
    const rows = await neighbours(state.path[state.path.length - 1]);

    for (const row of rows.slice(0, fanout)) {
      // Cycle guard: a path may not revisit a node it already contains. Without
      // this, any triangle in the graph generates infinitely many "paths" that
      // are the same three entities walked round and round.
      if (state.path.includes(row.entity_key)) continue;

      const path = [...state.path, row.entity_key];
      const documents = [...state.documents, row.document_ids];
      const strengths = [...state.strengths, row.strength];

      if (row.entity_key === toKey) {
        // Belt and braces: unique node sequences cannot be built twice by this
        // traversal, but a store that returns duplicate rows should not be able
        // to produce a duplicate finding either.
        const signature = path.join('\u0000');
        if (seenPaths.has(signature)) continue;
        seenPaths.add(signature);
        results.push({
          path,
          hops: path.length - 1,
          documents,
          // A chain is only as good as its worst hop. One 40-entity bulletin
          // anywhere along the route makes the whole route weak evidence, and
          // averaging would hide exactly that. Surfaced so a human can judge it
          // rather than having the code silently decide for them.
          weakest_link: round3(Math.min(...strengths)),
        });
        if (results.length >= limit) break;
        continue; // do not walk THROUGH the target; that is not a new finding
      }

      if (path.length - 1 < maxHops) queue.push({ path, documents, strengths });
    }
  }

  // Shortest first, then strongest, then a stable string tie-break.
  return results.sort((a, b) =>
    a.hops - b.hops ||
    b.weakest_link - a.weakest_link ||
    a.path.join('>').localeCompare(b.path.join('>')));
}

// ---------------------------------------------------------------- cluster

// The neighbourhood around an entity, shaped for rendering.
export async function clusterAround(entityKey, options = {}) {
  const {
    maxHops = 2,
    minShared = 1,
    store,
    fanout = CLUSTER_FANOUT_CAP,
    maxNodes = CLUSTER_MAX_NODES,
  } = options;
  if (!entityKey) return { nodes: [], edges: [] };

  const s = await resolveStore(store);

  // The anchor's own type and label are unknown here — the store describes an
  // entity's NEIGHBOURS, not the entity you asked about. They get filled in if
  // the anchor turns up in someone else's neighbour list, which it will whenever
  // the cluster reaches two hops.
  const nodes = new Map([[entityKey, { entity_key: entityKey, entity_type: null, entity_label: null, hops: 0 }]]);
  const edges = new Map();

  let frontier = [entityKey];
  let capped = false;

  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = [];
    for (const key of frontier) {
      if (nodes.size >= maxNodes) { capped = true; break; }
      const rows = await fetchRanked(s, key, { minShared, limit: fanout });

      for (const row of rows) {
        if (row.entity_key === key) continue; // defensive; rankNeighbours drops these

        const known = nodes.get(row.entity_key);
        if (!known) {
          if (nodes.size >= maxNodes) { capped = true; break; }
          nodes.set(row.entity_key, {
            entity_key: row.entity_key,
            entity_type: row.entity_type,
            entity_label: row.entity_label,
            hops: hop + 1, // first sighting is the shortest distance, BFS order
          });
          next.push(row.entity_key);
        } else if (known.entity_label == null) {
          known.entity_type = row.entity_type;
          known.entity_label = row.entity_label; // this is how the anchor gets named
        }

        addEdge(edges, key, row);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // An edge to a node the cap excluded would render as a line into nothing.
  const kept = [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to));

  return {
    nodes: [...nodes.values()].sort((a, b) => a.hops - b.hops || a.entity_key.localeCompare(b.entity_key)),
    edges: kept.sort((a, b) =>
      b.strength - a.strength || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    // Honest about truncation: a cluster that hit the cap is a view, not the
    // whole neighbourhood, and the interface should be able to say so.
    truncated: capped,
  };
}

function addEdge(edges, fromKey, row) {
  // Canonical undirected key, so the same pair discovered from either end is one
  // edge rather than two overlapping lines.
  const [from, to] = [fromKey, row.entity_key].sort();
  const id = `${from}\u0000${to}`;
  const existing = edges.get(id);
  if (!existing) {
    edges.set(id, {
      from,
      to,
      strength: row.strength,
      shared_documents: row.shared_documents,
      document_ids: row.document_ids,
    });
    return;
  }
  // Both directions computed the same pair. They agree unless one side's
  // neighbour list was truncated at the fetch limit, and truncation only ever
  // makes documents look LESS promiscuous and strength higher. So the lower
  // value is the one computed from the more complete evidence — keep it.
  if (row.strength < existing.strength) {
    existing.strength = row.strength;
    existing.shared_documents = row.shared_documents;
    existing.document_ids = row.document_ids;
  }
}
