import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findConnections, findPaths, clusterAround } from '../lib/corpus/connections.js';

// No database and no model anywhere in this file. The store is injected, so
// these tests describe the graph behaviour exactly and run on any machine.
//
// The fake computes entitiesSharingDocuments the way a real store must: from a
// document -> entities mapping. That matters, because the promiscuity dampening
// is derived from how many of the anchor's neighbours share each document, and a
// fake that just returned hand-written strength inputs would test nothing.

function typeOf(key) { return key.split(':')[0]; }
function labelOf(key) { return key.split(':').slice(1).join(':'); }

function makeStore(documents, options = {}) {
  const { ignoreLimit = false, calls = null, injectSelfRow = false } = options;

  const docsById = new Map(documents.map((d) => [d.id, {
    id: d.id,
    url: d.url || `https://example.test/${d.id}`,
    title: d.title || `Document ${d.id}`,
    source: d.source || 'test-source',
    published_ms: d.published_ms ?? 0,
    snippet: d.snippet || '',
  }]));

  return {
    documentCalls: 0,
    async entitiesSharingDocuments(entityKey, limit = 40) {
      if (calls) calls.push({ fn: 'entitiesSharingDocuments', entityKey, limit });

      const byNeighbour = new Map();
      for (const doc of documents) {
        if (!doc.entities.includes(entityKey)) continue;
        for (const other of doc.entities) {
          if (other === entityKey) continue;
          if (!byNeighbour.has(other)) byNeighbour.set(other, []);
          byNeighbour.get(other).push(doc.id);
        }
      }

      const rows = [...byNeighbour.entries()].map(([key, ids]) => ({
        entity_key: key,
        entity_type: typeOf(key),
        entity_label: labelOf(key),
        shared_documents: ids.length,
        document_ids: ids,
      })).sort((a, b) => b.shared_documents - a.shared_documents || a.entity_key.localeCompare(b.entity_key));

      // A store that hands back the anchor itself. Real ones should not, but the
      // self-edge is trivially true and must never reach a caller.
      if (injectSelfRow) {
        rows.unshift({
          entity_key: entityKey,
          entity_type: typeOf(entityKey),
          entity_label: labelOf(entityKey),
          shared_documents: 99,
          document_ids: documents.filter((d) => d.entities.includes(entityKey)).map((d) => d.id),
        });
      }

      return ignoreLimit ? rows : rows.slice(0, limit);
    },
    async documentsById(ids) {
      this.documentCalls += 1;
      if (calls) calls.push({ fn: 'documentsById', ids });
      return ids.map((id) => docsById.get(id)).filter(Boolean);
    },
    async documentsForEntity(entityKey, limit = 20) {
      return documents
        .filter((d) => d.entities.includes(entityKey))
        .slice(0, limit)
        .map((d) => docsById.get(d.id));
    },
  };
}

// A store that answers any key with `width` synthetic neighbours and ignores the
// limit entirely — the hub case the traversal caps exist for.
function makeHubStore(width, calls) {
  return {
    async entitiesSharingDocuments(entityKey) {
      calls.push(entityKey);
      return Array.from({ length: width }, (_, i) => ({
        entity_key: `node:${entityKey}/${i}`,
        entity_type: 'node',
        entity_label: `${entityKey}/${i}`,
        shared_documents: 1,
        document_ids: [`doc:${entityKey}/${i}`],
      }));
    },
    async documentsById() { return []; },
    async documentsForEntity() { return []; },
  };
}

const SHIP = 'vessel:Ruby Princess';
const RESTAURANT = 'restaurant:Quay Bistro';
const HOSPITAL = 'hospital:Royal North Shore';

// ---------------------------------------------------------------- dampening

test('a two-entity document is worth far more than a forty-entity bulletin', async () => {
  // The whole point of the dampening. Both neighbours share exactly ONE document
  // with the ship, so any count-based score rates them identically.
  const bulletinEntities = [SHIP, ...Array.from({ length: 39 }, (_, i) => `berth:B${String(i).padStart(2, '0')}`)];
  const store = makeStore([
    { id: 'd_pair', entities: [SHIP, RESTAURANT] },
    { id: 'd_bulletin', entities: bulletinEntities },
  ]);

  const rows = await findConnections(SHIP, { store, limit: 50 });
  const restaurant = rows.find((r) => r.entity_key === RESTAURANT);
  const berth = rows.find((r) => r.entity_key === 'berth:B00');

  assert.equal(restaurant.shared_documents, 1);
  assert.equal(berth.shared_documents, 1, 'same shared count on both edges');

  // w = 1/(entities-1): 1/1 for the pair, 1/39 for the bulletin.
  assert.equal(restaurant.strength, 0.5);
  assert.equal(berth.strength, 0.025);
  assert.ok(restaurant.strength > berth.strength * 15, 'exclusive co-mention must dominate');

  // Strongest first.
  assert.equal(rows[0].entity_key, RESTAURANT);
});

test('strength rises with more exclusive documents but never reaches 1', async () => {
  const store = makeStore([
    { id: 'a1', entities: [SHIP, RESTAURANT] },
    { id: 'a2', entities: [SHIP, RESTAURANT] },
    { id: 'a3', entities: [SHIP, RESTAURANT] },
    { id: 'b1', entities: [SHIP, HOSPITAL] },
  ]);
  const rows = await findConnections(SHIP, { store });
  const strong = rows.find((r) => r.entity_key === RESTAURANT);
  const weak = rows.find((r) => r.entity_key === HOSPITAL);

  assert.equal(strong.shared_documents, 3);
  assert.equal(strong.strength, 0.75); // 3/(3+1)
  assert.equal(weak.strength, 0.5);
  assert.ok(strong.strength < 1, 'co-mention is never proof, so strength must not saturate to certainty');
});

test('a shared document dampens every pair inside it equally', async () => {
  // Four entities in one document: each pair gets 1/3, not 1.
  const store = makeStore([
    { id: 'quad', entities: [SHIP, RESTAURANT, HOSPITAL, 'berth:B1'] },
  ]);
  const rows = await findConnections(SHIP, { store });
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.strength, 0.25); // (1/3)/(1/3+1)
});

// ---------------------------------------------------------------- hygiene

test('the anchor never appears in its own connections', async () => {
  const store = makeStore(
    [{ id: 'd1', entities: [SHIP, RESTAURANT] }],
    { injectSelfRow: true },
  );
  const rows = await findConnections(SHIP, { store });
  assert.ok(!rows.some((r) => r.entity_key === SHIP), 'self-loop must be dropped');
  assert.equal(rows.length, 1);
});

test('minShared and limit are both honoured', async () => {
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT] },
    { id: 'd2', entities: [SHIP, RESTAURANT] },
    { id: 'd3', entities: [SHIP, HOSPITAL] },
    { id: 'd4', entities: [SHIP, 'berth:B1'] },
  ]);

  const filtered = await findConnections(SHIP, { store, minShared: 2 });
  assert.deepEqual(filtered.map((r) => r.entity_key), [RESTAURANT]);

  const limited = await findConnections(SHIP, { store, limit: 2 });
  assert.equal(limited.length, 2);
});

test('the same corpus produces byte-identical findings on a re-run', async () => {
  // A finding that changes shape between runs is not auditable.
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT, HOSPITAL] },
    { id: 'd2', entities: [SHIP, HOSPITAL] },
    { id: 'd3', entities: [SHIP, 'berth:B1'] },
  ]);
  const first = await findConnections(SHIP, { store });
  const second = await findConnections(SHIP, { store });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('includeDocuments hydrates evidence in one batched call', async () => {
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT], title: 'Passengers report illness' },
    { id: 'd2', entities: [SHIP, HOSPITAL], title: 'Admissions rise' },
  ]);
  const rows = await findConnections(SHIP, { store, includeDocuments: true });
  assert.equal(store.documentCalls, 1, 'one query for the whole panel, not one per neighbour');
  const restaurant = rows.find((r) => r.entity_key === RESTAURANT);
  assert.equal(restaurant.documents[0].title, 'Passengers report illness');
  assert.equal(restaurant.documents[0].url, 'https://example.test/d1');
});

// ---------------------------------------------------------------- paths

test('ship -> restaurant -> hospital: the chain no database holds', async () => {
  // The motivating case. Nothing links the vessel to the hospital directly;
  // the only route is through a restaurant that shares a document with each.
  const store = makeStore([
    { id: 'd_ship_rest', entities: [SHIP, RESTAURANT] },
    { id: 'd_rest_hosp', entities: [RESTAURANT, HOSPITAL] },
  ]);

  const direct = await findConnections(SHIP, { store });
  assert.ok(!direct.some((r) => r.entity_key === HOSPITAL), 'no direct co-mention exists');

  const paths = await findPaths(SHIP, HOSPITAL, { store, maxHops: 3 });
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].path, [SHIP, RESTAURANT, HOSPITAL]);
  assert.equal(paths[0].hops, 2);
  assert.deepEqual(paths[0].documents, [['d_ship_rest'], ['d_rest_hosp']]);
  assert.equal(paths[0].weakest_link, 0.5);
});

test('weakest_link reports the worst hop, not the average', async () => {
  // Hop 1 is an exclusive pair (0.5). Hop 2 runs through a ten-entity bulletin
  // (0.1). A chain through that bulletin is weak evidence and must say so.
  const crowd = Array.from({ length: 8 }, (_, i) => `facility:F${i}`);
  const store = makeStore([
    { id: 'd_ship_rest', entities: [SHIP, RESTAURANT] },
    { id: 'd_bulletin', entities: [RESTAURANT, HOSPITAL, ...crowd] },
  ]);

  const paths = await findPaths(SHIP, HOSPITAL, { store, maxHops: 2 });
  assert.equal(paths.length, 1);

  const hop2 = (await findConnections(RESTAURANT, { store })).find((r) => r.entity_key === HOSPITAL);
  assert.equal(hop2.strength, 0.1);
  assert.equal(paths[0].weakest_link, 0.1, 'the lower of {0.5, 0.1}');
  // Explicitly not the mean of the two hops.
  assert.notEqual(paths[0].weakest_link, 0.3);
});

test('cycles never produce a path that revisits a node', async () => {
  // A triangle. Walked naively this yields A->B->C->A->B->... forever.
  const A = 'vessel:A'; const B = 'restaurant:B'; const C = 'hospital:C';
  const store = makeStore([
    { id: 'ab', entities: [A, B] },
    { id: 'bc', entities: [B, C] },
    { id: 'ca', entities: [C, A] },
  ]);

  const paths = await findPaths(A, C, { store, maxHops: 3 });
  for (const p of paths) {
    assert.equal(new Set(p.path).size, p.path.length, `repeated node in ${p.path.join(' > ')}`);
  }
  assert.deepEqual(paths.map((p) => p.path), [[A, C], [A, B, C]], 'shortest first, each route once');
});

test('duplicate paths are never returned twice', async () => {
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT] },
    { id: 'd2', entities: [SHIP, RESTAURANT] },
    { id: 'd3', entities: [RESTAURANT, HOSPITAL] },
    { id: 'd4', entities: [RESTAURANT, HOSPITAL] },
  ]);
  const paths = await findPaths(SHIP, HOSPITAL, { store, maxHops: 3 });
  const signatures = paths.map((p) => p.path.join('>'));
  assert.equal(new Set(signatures).size, signatures.length);
});

test('a path from an entity to itself is not a finding', async () => {
  const store = makeStore([{ id: 'd1', entities: [SHIP, RESTAURANT] }]);
  assert.deepEqual(await findPaths(SHIP, SHIP, { store }), []);
});

test('maxHops is a hard boundary', async () => {
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT] },
    { id: 'd2', entities: [RESTAURANT, 'clinic:GP'] },
    { id: 'd3', entities: ['clinic:GP', HOSPITAL] },
  ]);
  assert.deepEqual(await findPaths(SHIP, HOSPITAL, { store, maxHops: 2 }), [], 'three hops is out of budget');
  const reached = await findPaths(SHIP, HOSPITAL, { store, maxHops: 3 });
  assert.equal(reached.length, 1);
  assert.equal(reached[0].hops, 3);
});

test('unreachable targets terminate instead of exhausting the graph', async () => {
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT] },
    { id: 'd2', entities: ['island:X', 'island:Y'] },
  ]);
  assert.deepEqual(await findPaths(SHIP, 'island:Y', { store, maxHops: 3 }), []);
});

// ------------------------------------------------- known limitation, pinned

test('a route through a promiscuous ENTITY scores like a genuine chain', async () => {
  // Measured, not assumed. The dampening is per document, so an agency that
  // appears in many separate two-entity articles has a full-weight edge to each
  // of them, and a path through it looks exactly as strong as a real chain.
  // This test exists so the behaviour is documented and cannot change silently:
  // if someone adds entity-degree damping later, this fails and they must decide
  // deliberately rather than discover it in production.
  const AGENCY = 'org:Health Department';
  const connector = makeStore([
    { id: 'a1', entities: [SHIP, AGENCY] },
    { id: 'a2', entities: [AGENCY, HOSPITAL] },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i + 3}`, entities: [AGENCY, `facility:Unrelated${i}`] })),
  ]);
  const genuine = makeStore([
    { id: 'g1', entities: [SHIP, RESTAURANT] },
    { id: 'g2', entities: [RESTAURANT, HOSPITAL] },
  ]);

  const [viaAgency] = await findPaths(SHIP, HOSPITAL, { store: connector, maxHops: 2 });
  const [viaRestaurant] = await findPaths(SHIP, HOSPITAL, { store: genuine, maxHops: 2 });

  assert.equal(viaAgency.weakest_link, viaRestaurant.weakest_link, 'indistinguishable on strength alone');

  // The distinguishing signal is available to a caller, one query away: the
  // agency connects to ten things, the restaurant to two.
  const agencyDegree = (await findConnections(AGENCY, { store: connector, limit: 100 })).length;
  const restaurantDegree = (await findConnections(RESTAURANT, { store: genuine, limit: 100 })).length;
  assert.equal(agencyDegree, 10);
  assert.equal(restaurantDegree, 2);
});

test('the fanout cap truncates by strength, then deterministically', async () => {
  // On a hub whose edges are all equally weak, the cap has to cut somewhere and
  // the tie-break is the entity key. That is arbitrary in substance but stable
  // across runs, which is the property that matters: the same corpus always
  // yields the same truncation, so a missing path is reproducible rather than
  // intermittent. Worth knowing that a low-strength edge can be dropped by the
  // cap before strength ever gets a chance to rank it out.
  const crowd = Array.from({ length: 38 }, (_, i) => `berth:B${String(i).padStart(2, '0')}`);
  const store = makeStore([
    { id: 'b1', entities: [SHIP, 'org:PortAuthority', ...crowd] },
    { id: 'b2', entities: ['org:PortAuthority', HOSPITAL] },
  ]);

  const narrow = await findPaths(SHIP, HOSPITAL, { store, maxHops: 2, fanout: 25 });
  const wide = await findPaths(SHIP, HOSPITAL, { store, maxHops: 2, fanout: 40 });
  assert.deepEqual(narrow, [], 'the connector sorts past the cap on an all-equal frontier');
  assert.equal(wide.length, 1, 'and is reachable once the cap is lifted');
  assert.equal(wide[0].weakest_link, 0.025, 'the bulletin hop is correctly rated near-worthless');

  // Reproducible, not intermittent.
  assert.deepEqual(await findPaths(SHIP, HOSPITAL, { store, maxHops: 2, fanout: 25 }), narrow);
});

// ---------------------------------------------------------------- blow-up caps

test('a hub does not blow up findConnections', async () => {
  const calls = [];
  const store = makeHubStore(300, calls); // a store that ignores the limit
  const rows = await findConnections('hub:Port', { store, limit: 25 });
  assert.equal(rows.length, 25, 'the caller asked for 25 and gets 25 regardless of the store');
});

test('path search stops at its expansion budget on a hub graph', async () => {
  // Every node has 300 neighbours. Unbounded, three hops is 300^3 expansions.
  const calls = [];
  const store = makeHubStore(300, calls);
  const paths = await findPaths('hub:Port', 'nowhere:Z', {
    store, maxHops: 3, fanout: 25, expansionBudget: 20,
  });
  assert.deepEqual(paths, []);
  assert.ok(calls.length <= 20, `expected <=20 store calls, got ${calls.length}`);
});

test('a hub is fetched once per traversal, not once per arrival', async () => {
  const calls = [];
  const store = makeStore([
    { id: 'd1', entities: [SHIP, 'hub:Port'] },
    { id: 'd2', entities: [RESTAURANT, 'hub:Port'] },
    { id: 'd3', entities: [SHIP, RESTAURANT] },
    { id: 'd4', entities: ['hub:Port', HOSPITAL] },
  ], { calls });

  await findPaths(SHIP, HOSPITAL, { store, maxHops: 3 });
  const hubFetches = calls.filter((c) => c.fn === 'entitiesSharingDocuments' && c.entityKey === 'hub:Port');
  assert.equal(hubFetches.length, 1, 'memoised across the frontier');
});

test('clusterAround caps its node count and admits it', async () => {
  const calls = [];
  const store = makeHubStore(300, calls);
  const cluster = await clusterAround('hub:Port', { store, maxHops: 2, maxNodes: 30 });
  assert.ok(cluster.nodes.length <= 30, `node cap breached: ${cluster.nodes.length}`);
  assert.equal(cluster.truncated, true, 'a truncated view must say it is truncated');
});

// ---------------------------------------------------------------- cluster

test('clusterAround returns a renderable graph with one edge per pair', async () => {
  const store = makeStore([
    { id: 'd1', entities: [SHIP, RESTAURANT] },
    { id: 'd2', entities: [RESTAURANT, HOSPITAL] },
    { id: 'd3', entities: [SHIP, RESTAURANT] },
  ]);

  const { nodes, edges } = await clusterAround(SHIP, { store, maxHops: 2 });

  assert.deepEqual(nodes.map((n) => n.entity_key).sort(), [HOSPITAL, RESTAURANT, SHIP].sort());
  assert.equal(nodes.find((n) => n.entity_key === SHIP).hops, 0);
  assert.equal(nodes.find((n) => n.entity_key === RESTAURANT).hops, 1);
  assert.equal(nodes.find((n) => n.entity_key === HOSPITAL).hops, 2);

  // The anchor's own label is unknown until a neighbour's neighbour names it.
  assert.equal(nodes.find((n) => n.entity_key === SHIP).entity_label, 'Ruby Princess');

  // Ship<->Restaurant is discovered from both ends; it must appear once.
  assert.equal(edges.length, 2);
  const pairs = edges.map((e) => `${e.from}|${e.to}`);
  assert.equal(new Set(pairs).size, pairs.length);
  for (const e of edges) assert.ok(e.from < e.to, 'edges are stored in canonical order');

  // Every edge endpoint is a node that was actually returned.
  const known = new Set(nodes.map((n) => n.entity_key));
  for (const e of edges) {
    assert.ok(known.has(e.from) && known.has(e.to), 'no edge may dangle off the cluster');
  }
});

test('clusterAround excludes the anchor from its own edges', async () => {
  const store = makeStore(
    [{ id: 'd1', entities: [SHIP, RESTAURANT] }],
    { injectSelfRow: true },
  );
  const { edges } = await clusterAround(SHIP, { store, maxHops: 1 });
  for (const e of edges) assert.notEqual(e.from, e.to);
});

test('clusterAround terminates on a cyclic graph', async () => {
  const A = 'vessel:A'; const B = 'restaurant:B'; const C = 'hospital:C';
  const store = makeStore([
    { id: 'ab', entities: [A, B] },
    { id: 'bc', entities: [B, C] },
    { id: 'ca', entities: [C, A] },
  ]);
  const { nodes, edges } = await clusterAround(A, { store, maxHops: 3 });
  assert.equal(nodes.length, 3);
  assert.equal(edges.length, 3);
});
