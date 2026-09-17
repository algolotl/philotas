// test/ontology-profiles.test.js
//
// Entity profiles: the text that describes an entity, the vector that text
// embeds to, and the identity of the embedding space that vector lives in.
//
// The identity is the load-bearing part. `entity_profiles.embed_model` is what a
// dense query will pin, exactly as lib/corpus/search.js pins it on `chunks`, and
// two embedding models in one VECTOR column are two incompatible spaces whose
// cosine distance does not error — it returns confident nonsense. So the tests
// below care less about "a row was written" than about WHICH identity was
// written against it and WHICH vector, and every negative fixture is checked to
// be negative for the reason it claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { EMBED_DIM, _resetModelProbe } from '../lib/embed.js';
import {
  profileTextFor,
  aliasesFor,
  entityKeyFor,
  upsertEntityProfiles,
  PROFILE_BATCH_SIZE,
} from '../lib/ontology/profiles.js';

// lib/ontology/build.js reaches sample-lake JSON through the modules it pulls
// in, without an import attribute. Same loader shim as test/ontology-route.test.js
// and test/vessels.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

// ---------------------------------------------------------------- fixtures

// Written out as a literal rather than derived from EMBED_DIM. A fixture built
// as Array.from({ length: EMBED_DIM }) pins the FORMULA and never the value: the
// dimension could drift to anything and this file would keep agreeing with it,
// while the VECTOR(1024) columns in lib/schema/semantic.sql would not. The
// literal is checked against EMBED_DIM in its own test below, so a drift fails
// loudly here instead of at INSERT.
const VECTOR_DIMENSIONS = 1024;

// A per-text marker in element 0, so an assertion can say "this row carries the
// vector produced for ITS OWN profile text" rather than only "a vector of the
// right length was written". A stub that handed every text the same vector would
// make the whole class of index-mapping bugs invisible.
const markerFor = (text) => {
  let hash = 7;
  for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) % 100_000;
  return hash;
};
const vectorFor = (text) => {
  const vector = new Array(VECTOR_DIMENSIONS).fill(0.01);
  vector[0] = markerFor(text);
  return vector;
};

const vessel = {
  type: 'Vessel', feed: 'vessels', id: 'vessels:OOCL SHANGHAI', label: 'OOCL SHANGHAI',
  coord: [151.2, -33.97],
  props: {
    title: 'OOCL SHANGHAI', mmsi: '477123456', imo: '9776171',
    ship_type: 'Container Ship', destination: 'PORT BOTANY',
  },
};

const tanker = {
  type: 'Vessel', feed: 'vessels', id: 'vessels:AL MAHBOOBAH', label: 'AL MAHBOOBAH',
  coord: [151.19, -33.98],
  props: { title: 'AL MAHBOOBAH', mmsi: '470123999', imo: '9412111', ship_type: 'Crude Oil Tanker' },
};

const berth = {
  type: 'Berth', feed: 'berths', id: 'berths:brotherson-10', label: 'Brotherson Dock 10',
  coord: [151.22, -33.97],
  props: { title: 'Brotherson Dock 10', radius_metres: 250, terminal: 'Patrick' },
};

// The identity this deployment's embedder actually reports, probed on the reference deployment,
// 2026-08-17: registry service `bge_8005`, one model `bge-m3`, n_embd 1024.
const CURRENT_MODEL = 'bge_8005:bge-m3';

// A foreign embedding space whose SERVICE HALF IS IDENTICAL. This is the bait
// that distinguishes the fix from the bug: an implementation comparing only the
// service — or comparing against `embed([]).service`, which is all an empty
// batch reports — sees `bge_8005` on both sides and calls this vector reusable.
// The model behind that endpoint was replaced in place, which is a routine
// upgrade, and both models are 1024 dimensions so EMBED_DIM cannot catch it.
const RETIRED_MODEL_SAME_SERVICE = 'bge_8005:bge-m3-retired';

const MODELS_BODY = {
  object: 'list',
  data: [{ id: 'bge-m3', object: 'model', owned_by: 'llamacpp', meta: { n_embd: VECTOR_DIMENSIONS } }],
};

// ---------------------------------------------------------------- stubs

// Routes the model probe separately from the vectors, and records what was sent.
// Answering every URL with the embeddings body — as the brief's fixture did —
// hands the model probe an embedding row, so a probe reading the wrong field
// would have passed.
function embedderStub({ down = false, downAfterCalls = Infinity, models = MODELS_BODY } = {}) {
  const calls = { models: 0, embeddings: 0, texts: [], inputs: [] };
  const handler = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/v1/models')) {
      calls.models += 1;
      if (down) throw new Error('connect ECONNREFUSED');
      return { ok: true, json: async () => models };
    }
    if (target.endsWith('/embeddings')) {
      const input = JSON.parse(init.body).input;
      calls.embeddings += 1;
      calls.inputs.push(input);
      calls.texts.push(...input);
      if (down || calls.embeddings > downAfterCalls) throw new Error('connect ECONNREFUSED');
      return {
        ok: true,
        json: async () => ({
          model: 'bge-m3',
          // Deliberately out of input order. @axoquant/llm sorts by `index`, so
          // this costs nothing when the mapping back to inputs is done properly
          // and exposes it when it is not.
          data: input.map((text, i) => ({ index: i, embedding: vectorFor(text) })).reverse(),
        }),
      };
    }
    throw new Error(`unexpected fetch to ${target}`);
  };
  return { handler, calls };
}

// Resets the per-process model probe as well as swapping fetch. Without the
// reset, the first test in this file to embed anything would fix the model
// identity for every test after it, and the test that serves TWO models would be
// answered from the single-model cache.
const withStubbedFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  _resetModelProbe();
  try { return await fn(); } finally { globalThis.fetch = real; _resetModelProbe(); }
};

function stubPool({ existing = [], failWriteFor = [] } = {}) {
  const pool = {
    seen: [],
    query: async (sql, params) => {
      pool.seen.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) return { rows: existing };
      if (/INSERT INTO entity_profiles/i.test(sql)) {
        if (failWriteFor.some((key) => params.includes(key))) {
          throw new Error('canceling statement due to statement timeout');
        }
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`the profile pass issued an unexpected query: ${sql}`);
    },
  };
  return pool;
}

// Waits for a value the code under test sets from a promise nobody awaits. Fails
// by timing out rather than by asserting on a null, so a refresh that never runs
// is a failure rather than a passing assertion about the absence of one.
async function waitFor(read, { timeoutMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value != null) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`nothing was recorded within ${timeoutMs} ms`);
}

const insertsIn = (pool) => pool.seen.filter(({ sql }) => /INSERT INTO entity_profiles/i.test(sql));
const selectsIn = (pool) => pool.seen.filter(({ sql }) => /^\s*SELECT/i.test(sql));

// Resolves a COLUMN in the upsert's column list back to the value bound to the
// placeholder sitting in the matching VALUES position. `params.includes(x)` is
// satisfied by a value bound at any placeholder at all — Task 4 found exactly
// that mutation surviving on lib/corpus/search.js — so an assertion about
// embed_model has to resolve the column, not scan the parameter list.
function boundColumn({ sql, params }, column) {
  const columnList = sql.match(/INSERT INTO entity_profiles\s*\(([^)]*)\)/i);
  assert.ok(columnList, 'the upsert names the columns it writes');
  const names = columnList[1].split(',').map((s) => s.trim());
  const valueList = sql.match(/VALUES\s*\(([^)]*)\)/i);
  assert.ok(valueList, 'the upsert has a VALUES list');
  const placeholders = valueList[1].split(',').map((s) => s.trim());
  assert.equal(names.length, placeholders.length, 'one bound value per named column');
  const at = names.indexOf(column);
  assert.ok(at >= 0, `the upsert writes ${column} (columns: ${names.join(', ')})`);
  const position = placeholders[at].match(/^\$(\d+)/);
  assert.ok(position, `${column} is bound to a placeholder rather than interpolated into the SQL`);
  return params[Number(position[1]) - 1];
}

// ---------------------------------------------------------------- profile text

test('a profile is built from feed attributes in a fixed order, never from case document text', () => {
  // entity_profiles has no case_id and is read by every case on the deployment.
  // A sentence lifted from one tenant's uploaded document would be retrievable
  // from every other tenant's search, and the case scope on `chunks` would not
  // help: the leak would be in a table that has no scope column at all.
  const text = profileTextFor(vessel);
  assert.match(text, /^Vessel: OOCL SHANGHAI/, 'the type and label open the profile');
  assert.match(text, /^ship_type: Container Ship$/m);
  assert.match(text, /^imo: 9776171$/m);
  assert.ok(!/\bdocument\b/i.test(text), 'no document text reaches a table with no case scope');

  // The attribute order is the module's, not the payload's, and it is pinned as a
  // whole string. A per-line match passes for any permutation, and a permutation
  // is a changed profile that re-embeds every entity on every poll.
  assert.equal(
    text,
    [
      'Vessel: OOCL SHANGHAI',
      'ship_type: Container Ship',
      'destination: PORT BOTANY',
      'mmsi: 477123456',
      'imo: 9776171',
    ].join('\n')
  );
  assert.equal(profileTextFor(vessel), text, 'the same entity produces byte-identical text, so "changed" means changed');
});

test('a re-ordered props object is not a changed profile', () => {
  // Feeds re-serialise their JSON. If the profile followed key order, a poll that
  // changed nothing would re-embed everything, and the embedder's budget would go
  // on discovering that nothing had happened.
  const shuffled = {
    ...vessel,
    props: {
      destination: 'PORT BOTANY', imo: '9776171', ship_type: 'Container Ship',
      mmsi: '477123456', title: 'OOCL SHANGHAI',
    },
  };
  assert.notDeepEqual(
    Object.keys(shuffled.props), Object.keys(vessel.props),
    'the fixture really is re-ordered, or this test proves nothing'
  );
  assert.equal(profileTextFor(shuffled), profileTextFor(vessel));
});

test('profiles survive the entity shapes the feeds actually produce', () => {
  // Every shape here comes out of induce() in lib/ontology/build.js: props is the
  // raw feature properties object and can be absent, and label falls back
  // through four fields before a synthetic one.
  assert.equal(profileTextFor({ type: 'Berth', label: 'Brotherson Dock 10' }), 'Berth: Brotherson Dock 10',
    'an entity with no props is a profile with no attributes, not a crash');
  assert.deepEqual(aliasesFor({ type: 'Berth', label: 'Brotherson Dock 10' }), []);

  const unlabelled = profileTextFor({ type: 'Vessel', props: { ship_type: 'Tug' } });
  assert.ok(!/undefined/.test(unlabelled), 'a missing label is not interpolated as the string "undefined"');
  assert.match(unlabelled, /^Vessel:/);

  // induce() sets label FROM props.title, so label === props.title is the normal
  // case rather than an edge one. The name must not be stated twice: `title` in
  // the attribute list would double it, and every profile in the maritime feeds
  // would carry its own name as an attribute.
  const occurrences = profileTextFor(vessel).split('OOCL SHANGHAI').length - 1;
  assert.equal(occurrences, 1, 'the label appears once, not once as the label and again as an attribute');

  // Non-ASCII vessel names are ordinary in this data. Any normalisation applied
  // here changes the text, so the profile reads as changed on the pass that adds
  // the normalisation and every entity re-embeds.
  const danish = { type: 'Vessel', label: 'MÆRSK MC-KINNEY MØLLER', props: { title: 'MÆRSK MC-KINNEY MØLLER', imo: '9619907' } };
  assert.match(profileTextFor(danish), /^Vessel: MÆRSK MC-KINNEY MØLLER$/m);
  const chinese = { type: 'Vessel', label: '海洋石油981', props: { title: '海洋石油981', ship_type: 'Drilling Rig' } };
  assert.match(profileTextFor(chinese), /^Vessel: 海洋石油981$/m);
  assert.equal(entityKeyFor(chinese), 'Vessel:海洋石油981');
});

test('identifiers become aliases; the label and the synthetic feed id do not', () => {
  const aliases = aliasesFor(vessel);
  // deepEqual rather than three includes(): it pins the order and, more
  // importantly, pins that nothing ELSE arrived.
  assert.deepEqual(aliases, ['477123456', '9776171']);
  assert.ok(!aliases.includes('OOCL SHANGHAI'), 'the label is already a column and an index; repeating it as an alias is noise');
  assert.ok(!aliases.includes('Container Ship'),
    'a descriptive attribute is not an identifier — aliasing it would trigram-match every container ship in the feed');
  assert.ok(!aliases.includes('vessels:OOCL SHANGHAI'),
    'the induced entity id is a feed-prefixed synthetic key that appears in no document');

  // Two identifier fields carrying the same string is what a feed does when it
  // has one number and two names for it.
  assert.deepEqual(aliasesFor({ type: 'Satellite', label: 'SENTINEL-1A', props: { norad: '39634', code: '39634' } }), ['39634']);
  // An identifier equal to the label adds nothing.
  assert.deepEqual(aliasesFor({ type: 'Aircraft', label: 'QFA123', props: { callsign: 'QFA123' } }), []);
});

test('the vector fixture is the dimension the schema declares', () => {
  // Three places have to agree: EMBED_DIM in lib/embed.js, the VECTOR(1024)
  // columns in lib/schema/semantic.sql, and the fixtures here. Mixed dimensions
  // in one vector column cannot be migrated, only regenerated.
  assert.equal(VECTOR_DIMENSIONS, 1024);
  assert.equal(EMBED_DIM, VECTOR_DIMENSIONS, 'the fixture embeds at the dimension the code embeds at');
  assert.equal(vectorFor('anything').length, 1024);
});

// ---------------------------------------------------------------- the upsert

test('the composed service:model identity is what lands in embed_model', async () => {
  const pool = stubPool();
  const { handler } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel]));

  assert.equal(result.written, 1);
  const [upsert] = insertsIn(pool);
  assert.ok(upsert, 'a profile was written');

  // The literal, resolved from the embed_model COLUMN. `bge_8005` alone is a
  // serving endpoint, not an embedding space: re-pointing that registry service
  // at a different 1024-dimension model leaves the value unchanged, so one
  // predicate matches two spaces and cosine distance across them returns
  // confident nonsense with nothing reporting it.
  assert.equal(boundColumn(upsert, 'embed_model'), CURRENT_MODEL);
  assert.notEqual(boundColumn(upsert, 'embed_model'), 'bge_8005',
    'the service half alone would cover two embedding spaces with one identifier');
  assert.equal(typeof boundColumn(upsert, 'embed_model'), 'string',
    'never undefined: an empty batch reports no embedModel, and a row labelled `undefined` is a foreign space wearing a plausible label');
  assert.ok(boundColumn(upsert, 'embed_model').includes(':'), 'both halves are present');

  // Every other column, resolved the same way. A value bound at the wrong
  // placeholder satisfies params.includes() and writes the wrong column.
  assert.equal(boundColumn(upsert, 'entity_key'), 'Vessel:OOCL SHANGHAI');
  assert.equal(boundColumn(upsert, 'entity_type'), 'Vessel');
  assert.equal(boundColumn(upsert, 'label'), 'OOCL SHANGHAI');
  assert.deepEqual(boundColumn(upsert, 'aliases'), ['477123456', '9776171']);
  assert.equal(boundColumn(upsert, 'profile_text'), profileTextFor(vessel));
  assert.equal(typeof boundColumn(upsert, 'updated_ms'), 'number');
  assert.ok(boundColumn(upsert, 'updated_ms') > 1_700_000_000_000, 'a real clock, not a placeholder zero');
  assert.match(upsert.sql, /ON CONFLICT \(entity_key\) DO UPDATE/i, 'a second pass updates rather than failing on the primary key');

  // entity_key is `Type:Label`, the same shape lib/corpus/service.js:42 builds
  // for corpus_entities. Two conventions for one key means the two tables never
  // describe the same entity.
  assert.equal(entityKeyFor(vessel), 'Vessel:OOCL SHANGHAI');
});

test('an unchanged profile in the current embedding space is not re-embedded and not rewritten', async () => {
  // Three DIFFERENT entities, all current. A single-entity fixture cannot tell
  // "one identity probe" from "re-embedded everything", because both are one
  // text; three can.
  const entities = [vessel, tanker, berth];
  const pool = stubPool({
    existing: entities.map((entity) => ({
      entity_key: entityKeyFor(entity),
      profile_text: profileTextFor(entity),
      embed_model: CURRENT_MODEL,
    })),
  });
  const { handler, calls } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, entities));

  assert.deepEqual(result, { considered: 3, changed: 0, embedded: 1, written: 0, degraded: null });
  assert.equal(calls.texts.length, 1,
    'exactly one text: the identity probe, which is the only way to learn which embedding space the stored vectors are in. Three would mean the change check was dropped');
  assert.equal(insertsIn(pool).length, 0, 'nothing changed, so no row was rewritten');

  // The stored state is read with the keys bound, not read in full and filtered
  // in JavaScript — on a deployment with 200,000 profiles that is the difference
  // between an index lookup and a table scan per pass.
  const [select] = selectsIn(pool);
  assert.match(select.sql, /entity_key\s*=\s*ANY\(\$1\)/i);
  assert.deepEqual(select.params[0], entities.map(entityKeyFor));
});

test('a profile whose text is unchanged but whose vector is from another model in the same service is re-embedded', async () => {
  // The bait's stored identity differs from the current one ONLY in the model
  // half. A check on the service — or on `embed([]).service`, which is all an
  // empty batch reports — sees no difference and reuses a vector from a space the
  // query will never be in.
  assert.equal(
    RETIRED_MODEL_SAME_SERVICE.split(':')[0], CURRENT_MODEL.split(':')[0],
    'the bait shares the service half, or it would be excluded by the very check it exists to test'
  );
  const entities = [vessel, tanker, berth];
  const pool = stubPool({
    existing: entities.map((entity) => ({
      entity_key: entityKeyFor(entity),
      profile_text: profileTextFor(entity),
      embed_model: entity === tanker ? RETIRED_MODEL_SAME_SERVICE : CURRENT_MODEL,
    })),
  });
  const { handler, calls } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, entities));

  assert.equal(result.changed, 1, 'a vector from a retired model is not reusable, whatever the text says');
  assert.equal(result.written, 1);
  assert.equal(result.degraded, null);
  // Two texts, one row. Nothing had textually changed, so the first text went to
  // the embedder purely to learn which space the stored vectors are in, and it
  // belonged to a profile that turned out to be current — its vector is discarded.
  // Three texts here would mean the whole set was re-embedded; one would mean the
  // identity was never established and the retired vector was left in place.
  assert.equal(result.embedded, 2);
  assert.deepEqual(calls.texts, [profileTextFor(vessel), profileTextFor(tanker)]);

  const inserts = insertsIn(pool);
  assert.equal(inserts.length, 1, 'only the stale profile is rewritten — the discarded probe vector writes nothing');
  assert.equal(boundColumn(inserts[0], 'entity_key'), entityKeyFor(tanker),
    'the row rewritten is the stale one, not whichever row happened to be first');
  assert.equal(boundColumn(inserts[0], 'embed_model'), CURRENT_MODEL);
});

test('a NULL embed_model is not a reusable vector', async () => {
  // Rows written before embed_model existed, and rows an interrupted pass left
  // behind. The text matches, so a text-only check leaves the vector in place
  // forever while every dense query excludes it.
  const pool = stubPool({
    existing: [{ entity_key: entityKeyFor(vessel), profile_text: profileTextFor(vessel), embed_model: null }],
  });
  const { handler } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel]));
  assert.equal(result.changed, 1);
  assert.equal(result.written, 1);
  assert.equal(boundColumn(insertsIn(pool)[0], 'embed_model'), CURRENT_MODEL);
});

test('the vector written against a profile is the one produced for that profile’s text', async () => {
  // Two changed profiles, two distinguishable vectors. A mapping that indexes the
  // returned vectors by position in the BATCH rather than position in the list
  // actually sent puts the wrong entity's vector in the wrong row — a defect no
  // dimension check and no NOT NULL constraint can see, and one that makes the
  // resolver confidently wrong about which ship a span refers to.
  assert.notEqual(markerFor(profileTextFor(vessel)), markerFor(profileTextFor(tanker)),
    'the two fixtures embed to distinguishable vectors, or this test proves nothing');
  const pool = stubPool();
  const { handler } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel, tanker]));

  assert.equal(result.written, 2);
  const byKey = new Map(insertsIn(pool).map((call) => [boundColumn(call, 'entity_key'), call]));
  for (const entity of [vessel, tanker]) {
    const call = byKey.get(entityKeyFor(entity));
    assert.ok(call, `${entityKeyFor(entity)} was written`);
    const literal = boundColumn(call, 'embedding');
    const values = literal.replace(/^\[|\]$/g, '').split(',');
    assert.equal(values.length, VECTOR_DIMENSIONS, 'the whole vector is written, not a truncated one');
    assert.equal(Number(values[0]), markerFor(profileTextFor(entity)),
      'the vector belongs to this profile’s own text');
    assert.match(literal, /^\[.*\]$/, 'pgvector takes a bracketed literal');
  }
});

test('an unreachable embedder is a named signal, nothing is written, and the counters still say work is pending', async () => {
  const pool = stubPool();
  const { handler } = embedderStub({ down: true });
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel]));

  assert.equal(result.degraded, 'no-embedder');
  assert.equal(typeof result.degraded, 'string',
    'a boolean would tell an operator that something failed and never which stage — lib/corpus/search.js names its signals for the same reason');
  assert.equal(result.written, 0);
  assert.equal(result.embedded, 0);
  assert.equal(result.considered, 1);
  assert.equal(result.changed, 1,
    'a text difference is knowable without the embedder, so the caller can tell "nothing needed doing" from "everything is still to do"');
  assert.equal(insertsIn(pool).length, 0,
    'a profile with no vector is worse than no profile: invisible to the dense leg, present to the trigram one, and silently asymmetric');
});

test('named signals compose in stage order rather than the last burying the first', async () => {
  // Three changed profiles, one per batch. The first row's write fails; the
  // embedder goes down before the third. Both failures are real, they happen in
  // that order, and a `degraded` that is assigned rather than accumulated reports
  // only the second — which is the failure an operator would then chase, having
  // never been told about the first.
  const pool = stubPool({ failWriteFor: [entityKeyFor(vessel)] });
  const { handler, calls } = embedderStub({ downAfterCalls: 2 });
  const result = await withStubbedFetch(handler, () =>
    upsertEntityProfiles(pool, [vessel, tanker, berth], { batchSize: 1 })
  );

  assert.equal(result.degraded, 'no-profile-write,no-embedder');
  // All five counters differ, and each one is the answer to a different question:
  // how many entities were examined, how many needed work, how many got a vector,
  // how many rows landed, and what broke.
  assert.deepEqual(result, { considered: 3, changed: 3, embedded: 2, written: 1, degraded: 'no-profile-write,no-embedder' });
  assert.equal(calls.embeddings, 3, 'the third call is the one that failed, and no fourth was attempted after it');
  assert.equal(insertsIn(pool).length, 2, 'the failed write was attempted; the third profile never got a vector to write');
});

test('a pass with nothing to embed touches neither the database nor the embedder', async () => {
  // `embed([])` returns { vectors: [], service } with NO embedModel — there are no
  // vectors to attribute. So a pass with nothing to do must not reach the
  // embedder at all: a code path that probed on an empty batch and wrote the
  // result would label rows `bge_8005:undefined`, which is a foreign embedding
  // space wearing a plausible label.
  for (const input of [[], undefined, null, [{ feed: 'vessels', props: {} }], [{ type: 'Vessel' }], [{ label: 'no type' }]]) {
    const pool = stubPool();
    const { handler, calls } = embedderStub();
    const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, input));
    assert.deepEqual(result, { considered: 0, changed: 0, embedded: 0, written: 0, degraded: null },
      `input ${JSON.stringify(input)} produced no work and no degradation`);
    assert.equal(pool.seen.length, 0, 'no query at all, not even the read');
    assert.equal(calls.embeddings, 0);
    assert.equal(calls.models, 0);
  }
});

test('the embedding-space identity costs no round trip of its own when there is work to do', async () => {
  // The identity cannot be learned from an empty batch: `embed([])` returns
  // { vectors: [], service } with no embedModel at all, because there are no
  // vectors to attribute. So it has to ride along with real work, and it does —
  // two new profiles are ONE request, not a probe followed by a batch.
  //
  // An earlier version of this test asserted only that no request carried an empty
  // input array. That assertion cannot fail: lib/embed.js returns early on an
  // empty batch without any HTTP call, so no mutation of this module could have
  // produced the request it was watching for.
  const pool = stubPool();
  const { handler, calls } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel, tanker]));
  assert.equal(result.embedded, 2);
  assert.equal(calls.embeddings, 1, 'one request, so the identity was free rather than a round trip of its own');
  assert.deepEqual(calls.inputs, [[profileTextFor(vessel), profileTextFor(tanker)]]);
});

test('the same entity twice is one profile', async () => {
  const pool = stubPool();
  const { handler } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel, { ...vessel }]));
  assert.equal(result.considered, 1, 'two feeds describing one hull is one row, not a write-write race with itself');
  assert.equal(result.written, 1);
  assert.equal(insertsIn(pool).length, 1);
});

test('embedding is batched, and the batch is 32', async () => {
  // 32 is what lib/ontology/profiles.js sends per request. The value is pinned as
  // a literal AND through its consequence: an assertion that recomputes the
  // expected call count from the exported constant agrees with any value the
  // constant takes, which pins the formula and never the value.
  assert.equal(PROFILE_BATCH_SIZE, 32);
  const many = Array.from({ length: 40 }, (_, i) => ({
    type: 'Vessel', label: `HULL ${i}`, props: { title: `HULL ${i}`, imo: `900000${i}`, ship_type: 'Container Ship' },
  }));
  const pool = stubPool();
  const { handler, calls } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, many));

  assert.equal(result.considered, 40);
  assert.equal(result.written, 40);
  assert.equal(calls.texts.length, 40, 'every profile is embedded exactly once');
  assert.equal(new Set(calls.texts).size, 40, 'and no text is sent twice');
  // 32 then 8. The embedding-space identity comes back with the first batch of
  // real work rather than costing a round trip of its own, so 40 changed profiles
  // are two requests. A batch of 64 would be one call; a batch of 16 would be three.
  assert.equal(calls.embeddings, 2);
  assert.deepEqual(calls.inputs.map((input) => input.length), [32, 8]);
});

test('a server that cannot name one model fails loudly rather than writing a vector under a guessed identity', async () => {
  // Not `.unavailable` and not degraded: an embedder serving two models is
  // reachable, so degrading past it writes vectors whose embed_model names one of
  // two spaces at random. The message has to name the shape, because a bare error
  // class is shared with the "no identifiable model" branch and an assertion on
  // the class alone survives a mutation that swaps the two.
  const pool = stubPool();
  const { handler } = embedderStub({
    models: { object: 'list', data: [{ id: 'bge-m3' }, { id: 'e5-large-v2' }] },
  });
  await assert.rejects(
    () => withStubbedFetch(handler, () => upsertEntityProfiles(pool, [vessel])),
    (err) => {
      assert.match(err.message, /serves 2 models/, 'the failure names how many models were served');
      assert.match(err.message, /bge-m3, e5-large-v2/, 'and which');
      assert.ok(!err.unavailable, 'a reachable server answering wrongly is a defect, not an outage');
      return true;
    }
  );
  assert.equal(insertsIn(pool).length, 0, 'nothing was written under a guessed identity');
});

test('the induced entity set is what feeds the profile pass, and the artifact never carries it', async () => {
  // Two failures in one: a profiles module nothing calls (the shape of the
  // applySemanticSchema defect), and a private field leaking into the object
  // /api/ontology spreads straight into Response.json.
  const { buildOntology, induceEntities } = await import('../lib/ontology/build.js');
  const feeds = {
    berths: { features: [{ properties: { title: 'Brotherson Dock 10', radius_metres: 250 }, geometry: { coordinates: [151.2, -33.97] } }] },
    vessels: { features: [{ properties: { title: 'OOCL SHANGHAI', imo: '9776171', speed_knots: 0.1 }, geometry: { coordinates: [151.2, -33.97] } }] },
  };

  const entities = induceEntities(feeds);
  assert.ok(Array.isArray(entities), 'a flat array, which is what upsertEntityProfiles iterates');
  assert.ok(entities.some((e) => e.type === 'Berth'), 'the berth is reachable for the profile refresh');
  assert.ok(entities.some((e) => e.type === 'Vessel'));

  // Consumed end to end, because the shape is the bug: induce() returns a
  // type -> entities MAP, and handing that map straight to upsertEntityProfiles
  // throws "is not iterable" on the first line and writes no profile at all —
  // a failure that looks, from outside, exactly like a deployment with no
  // corpus store.
  const pool = stubPool();
  const { handler } = embedderStub();
  const result = await withStubbedFetch(handler, () => upsertEntityProfiles(pool, entities));
  assert.equal(result.considered, entities.length);
  assert.equal(result.written, entities.length);
  assert.equal(result.degraded, null);

  const artifact = await buildOntology(feeds);
  for (const key of Object.keys(artifact)) {
    assert.ok(!key.startsWith('_'), `artifact carries a private field ${key}, which /api/ontology would serve to every client`);
  }
  assert.ok(!('entities' in artifact), 'the raw entity set is not part of the public artifact');
});

test('the ontology pass is what triggers the profile refresh', async () => {
  // Global Constraint 2, and the defect it exists for: applySemanticSchema sat
  // unused for a whole increment while looking finished. A profiles module nothing
  // calls is the same failure, and no assertion about profiles.js can catch it.
  //
  // A region with no layers fetches no feed, so this needs neither the network nor
  // a database. It reaches as far as the corpus-store check — the deployment
  // default with no DATABASE_URL set — which is the honest limit of a test with no
  // Postgres: it proves the refresh is CALLED from the ontology pass, not what the
  // refresh then writes.
  const { getOntology, lastProfileRefreshResult } = await import('../lib/ontology/service.js');
  assert.equal(lastProfileRefreshResult(), null, 'no refresh has run in this process yet');

  const artifact = await getOntology({ id: 'test-profile-wiring', layers: [] });
  assert.equal(artifact.stats.entities, 0, 'no feeds, no entities — and no network reached to find that out');

  assert.deepEqual(
    await waitFor(lastProfileRefreshResult),
    { skipped: 'no-corpus-store' },
    'the refresh ran off the back of the ontology pass and named why it stopped'
  );
});
