// test/corpus-enrichment-seed.test.js
//
// Pins the enrichment-queue fix in lib/corpus/service.js: when nothing is due
// (everyone scheduled sits in the future), the pass must seed the candidates
// the schedule has NOT reached yet — not re-pick the first ENTITIES_PER_PASS
// forever. The original `candidates.slice(0, 8)` fallback meant that once the
// first 8 entities were given a future next_due_ms, every subsequent pass hit
// the empty-due branch, re-enriched the same 8, pushed their due time out
// again, and permanently starved entities 9+.
//
// The seeding decision lives in the exported pure function
// selectEnrichmentBatch, so it is tested directly — no database, no network.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The ontology service (which corpus/service.js imports for searchableEntities)
// reaches lib/data/sample-lake/berths.json without an import attribute. Node's
// own ESM loader requires `with { type: 'json' }` and throws otherwise. Same
// shim as test/vessels.test.js — registered process-scoped as a data: URL so it
// needs no file of its own.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

let selectEnrichmentBatch;

before(async () => {
  ({ selectEnrichmentBatch } = await import('../lib/corpus/service.js'));
});

const candidates = Array.from({ length: 30 }, (_, i) => ({
  entity_key: `Vessel:CANDIDATE-${i}`,
  entity_type: 'Vessel',
  entity_label: `Candidate ${i}`,
}));

test('when something is due, the due batch is used', () => {
  const due = [candidates[2], candidates[7]];
  const batch = selectEnrichmentBatch(candidates, due, [], 8);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].entity_key, 'Vessel:CANDIDATE-2');
  assert.equal(batch[1].entity_key, 'Vessel:CANDIDATE-7');
});

test('when nothing is due, the unscheduled tail is seeded, not the head', () => {
  // The regression: with the first 8 scheduled (future next_due_ms) and
  // nothing due, the OLD code picked candidates[0..7] again. The fix must pick
  // candidates[8..15] — the tail the schedule has not reached.
  const scheduled = candidates.slice(0, 8).map((c) => c.entity_key);
  const batch = selectEnrichmentBatch(candidates, [], scheduled, 8);
  assert.equal(batch.length, 8);
  assert.equal(batch[0].entity_key, 'Vessel:CANDIDATE-8');
  assert.equal(batch.at(-1).entity_key, 'Vessel:CANDIDATE-15');
});

test('when the whole queue is scheduled, nothing new is seeded', () => {
  const scheduled = candidates.map((c) => c.entity_key);
  const batch = selectEnrichmentBatch(candidates, [], scheduled, 8);
  assert.equal(batch.length, 0);
});

test('seed order respects the entity order, not a stable slice of the head', () => {
  // Two passes: first seeds the head (0-7), then the tail (8-15). Working
  // through the whole queue in order, not the same 8 forever.
  const first = selectEnrichmentBatch(candidates, [], [], 8);
  const afterFirst = first.map((c) => c.entity_key);
  const second = selectEnrichmentBatch(candidates, [], afterFirst, 8);
  assert.deepEqual(second.map((c) => c.entity_key), candidates.slice(8, 16).map((c) => c.entity_key));
});
