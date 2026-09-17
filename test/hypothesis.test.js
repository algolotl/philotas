import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proposeHypotheses } from '../lib/corpus/hypothesis.js';

// The model and the governor are both injected. Nothing here reaches a network,
// which is the only way to assert what happens when the model misbehaves — and
// misbehaving model output is precisely what this module exists to contain.

const SHIP = 'vessel:Ruby Princess';
const RESTAURANT = 'restaurant:Quay Bistro';
const HOSPITAL = 'hospital:Royal North Shore';

// service.js passes {key,type,label}; connections.js results are {entity_key,...}.
const ENTITIES = [
  { key: SHIP, type: 'Vessel', label: 'Ruby Princess' },
  { key: RESTAURANT, type: 'Facility', label: 'Quay Bistro' },
  { key: HOSPITAL, type: 'Facility', label: 'Royal North Shore' },
];

const DOCUMENTS = [
  { id: 'd1', url: 'https://example.test/ship', title: 'Passengers report illness', source: 'news', published_ms: 1_700_000_000_000, snippet: 'Several passengers reported gastrointestinal illness.' },
  { id: 'd2', url: 'https://example.test/rest', title: 'Gastro cases linked to venues', source: 'health', published_ms: 1_700_050_000_000, snippet: 'The health district reported cases at several venues.' },
];

const GOOD = {
  entity_keys: [SHIP, RESTAURANT],
  statement: 'The vessel and the restaurant appear in the same week of public reporting, which may indicate a shared exposure event ashore before departure.',
  confirms_if: 'Compare the health district notification dates with the vessel departure time recorded in port logs.',
  refutes_if: 'Check whether the venue cases were notified before any passenger came ashore that week.',
  document_ids: ['d1', 'd2'],
};

const SECOND = {
  entity_keys: [HOSPITAL, RESTAURANT],
  statement: 'Admissions described by the hospital may be consistent with the gastrointestinal cluster in the venue coverage.',
  confirms_if: 'Request the health district case line list and match onset dates to the venue reporting window.',
  refutes_if: 'Establish that the admissions predate the earliest venue report by more than one week.',
  document_ids: ['d2'],
};

// A model that returns exactly what you hand it.
function modelReturning(payload) {
  return async () => (typeof payload === 'string' ? payload : JSON.stringify(payload));
}
const allowAll = async () => ({ ok: true, verdict: 'allow', reasons: [], checks: { sources: 'ok' }, method: 'rules' });

function propose(overrides = {}) {
  return proposeHypotheses({
    entities: ENTITIES,
    documents: DOCUMENTS,
    region: 'sydney',
    callModel: modelReturning({ hypotheses: [GOOD] }),
    govern: allowAll,
    now: () => 1_700_100_000_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------- shape

test('a clean hypothesis survives and carries its full audit shape', async () => {
  const [h] = await propose();
  assert.ok(h, 'expected one hypothesis');
  assert.equal(h.statement, GOOD.statement);
  assert.deepEqual(h.entity_keys, [SHIP, RESTAURANT]);
  assert.deepEqual(h.document_ids, ['d1', 'd2']);
  assert.deepEqual(h.document_urls, ['https://example.test/ship', 'https://example.test/rest']);
  assert.equal(h.method, 'llm');
  assert.equal(h.created_ms, 1_700_100_000_000);
  assert.deepEqual(h.governor, { verdict: 'allow', reasons: [], checks: { sources: 'ok' } });
  assert.ok(h.id.startsWith('hyp_'));
});

test('unverified is always true and cannot be configured away', async () => {
  // The model asking for it, and a caller asking for it, both get ignored.
  const [h] = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, unverified: false, verified: true }] }),
    unverified: false,
  });
  assert.equal(h.unverified, true);
});

test('unverified survives a governor that returns its own fields', async () => {
  const [h] = await propose({
    govern: async () => ({ ok: true, verdict: 'allow', unverified: false, reasons: ['clean'], checks: null }),
  });
  assert.equal(h.unverified, true);
  assert.deepEqual(h.governor.reasons, ['clean']);
});

test('the same claim over the same evidence keeps the same id across runs', async () => {
  const [a] = await propose();
  const [b] = await propose({ now: () => 999 });
  assert.equal(a.id, b.id, 'ids are content-addressed so a re-run can be diffed');
});

test('the same claim proposed twice is returned once', async () => {
  const out = await propose({ callModel: modelReturning({ hypotheses: [GOOD, { ...GOOD }] }) });
  assert.equal(out.length, 1);
});

test('entity_key shaped entities are accepted as well as key shaped ones', async () => {
  const out = await propose({
    entities: [
      { entity_key: SHIP, entity_type: 'Vessel', entity_label: 'Ruby Princess' },
      { entity_key: RESTAURANT, entity_type: 'Facility', entity_label: 'Quay Bistro' },
    ],
  });
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------- governance

test('a governor rejection drops the hypothesis entirely', async () => {
  // Not downgraded, not flagged, not returned with a warning. Gone.
  const govern = async ({ text }) => (text.includes('shared exposure')
    ? { ok: false, verdict: 'block', reasons: ['speculative attribution'], checks: {} }
    : { ok: true, verdict: 'allow', reasons: [], checks: {} });

  const out = await propose({ callModel: modelReturning({ hypotheses: [GOOD, SECOND] }), govern });
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, SECOND.statement);
  assert.ok(!JSON.stringify(out).includes('shared exposure'), 'no trace of the rejected claim may survive');
});

test('every hypothesis is rejected when the governor rejects everything', async () => {
  const out = await propose({
    callModel: modelReturning({ hypotheses: [GOOD, SECOND] }),
    govern: async () => ({ ok: false, verdict: 'block', reasons: ['region mismatch'], checks: {} }),
  });
  assert.deepEqual(out, []);
});

test('a governor that throws approves nothing', async () => {
  // Fail closed: an error is not consent.
  const out = await propose({ govern: async () => { throw new Error('governor offline'); } });
  assert.deepEqual(out, []);
});

test('a governor returning no ok field approves nothing', async () => {
  const out = await propose({ govern: async () => ({ verdict: 'allow', reasons: [] }) });
  assert.deepEqual(out, []);
});

test('the governor is called with the hypothesis kind, its own citations and both tests', async () => {
  const seen = [];
  await propose({
    govern: async (args) => { seen.push(args); return { ok: true, verdict: 'allow', reasons: [], checks: {} }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'hypothesis');
  assert.equal(seen[0].region, 'sydney');
  assert.deepEqual(seen[0].allowedSourceUrls, ['https://example.test/ship', 'https://example.test/rest']);
  assert.ok(seen[0].text.includes('Confirms if:'), 'the tests are part of the claim under review');
  assert.ok(seen[0].text.includes('Refutes if:'));
  assert.deepEqual(seen[0].entities.map((e) => e.key), [SHIP, RESTAURANT]);
});

// ---------------------------------------------------------------- model down

test('an unreachable model yields an empty list, not a fallback', async () => {
  // There is deliberately no deterministic fallback: a template that speculates
  // about a named restaurant is worse than silence.
  const out = await propose({ callModel: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual(out, []);
});

test('the real adapter returns nothing when the model is switched off', async () => {
  // No callModel injected: this exercises the default adapter, which must not
  // reach the network, must not resolve the governor, and must not invent a
  // deterministic hypothesis when ONTOLOGY_LLM=off.
  const previous = process.env.ONTOLOGY_LLM;
  process.env.ONTOLOGY_LLM = 'off';
  try {
    const out = await proposeHypotheses({ entities: ENTITIES, documents: DOCUMENTS, region: 'sydney' });
    assert.deepEqual(out, []);
  } finally {
    if (previous === undefined) delete process.env.ONTOLOGY_LLM;
    else process.env.ONTOLOGY_LLM = previous;
  }
});

test('a null, empty or unparseable model response yields an empty list', async () => {
  for (const payload of [null, '', 'I am unable to help with that.', '{"hypotheses":null}', '[]', '{}']) {
    const out = await propose({ callModel: async () => payload });
    assert.deepEqual(out, [], `expected [] for ${JSON.stringify(payload)}`);
  }
});

test('no documents means no model call at all', async () => {
  let called = false;
  const out = await proposeHypotheses({
    entities: ENTITIES,
    documents: [],
    region: 'sydney',
    callModel: async () => { called = true; return '{}'; },
    govern: allowAll,
  });
  assert.deepEqual(out, []);
  assert.equal(called, false, 'nothing to cite, so nothing to ask');
});

test('no entities means no model call at all', async () => {
  let called = false;
  const out = await proposeHypotheses({
    entities: [],
    documents: DOCUMENTS,
    callModel: async () => { called = true; return '{}'; },
    govern: allowAll,
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('JSON wrapped in prose is recovered rather than discarded', async () => {
  const out = await propose({
    callModel: async () => `Here you go:\n${JSON.stringify({ hypotheses: [GOOD] })}\nHope that helps.`,
  });
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------- quarantine
//
// Every case below uses a governor that approves everything, so a drop can only
// come from this module's own structural checks. The prompt states these rules;
// these tests prove the code enforces them when the prompt is ignored.

test('an unhedged statement is dropped', async () => {
  const out = await propose({
    callModel: modelReturning({ hypotheses: [{
      ...GOOD,
      statement: 'The outbreak at the restaurant originated with passengers from the vessel earlier that week.',
    }] }),
  });
  assert.deepEqual(out, []);
});

for (const [label, blamed] of [
  ['negligence', 'Conditions at the venue may indicate negligent food handling during the reporting week.'],
  ['fault', 'One reading is that the operator failed to notify the health district within the required window.'],
  ['criminality', 'The pattern may indicate unlawful conduct by the venue operator during that period.'],
  ['responsibility', 'One reading is that the vessel operator was responsible for the cluster reported ashore.'],
]) {
  test(`a statement attributing ${label} to a named party is dropped`, async () => {
    const out = await propose({
      callModel: modelReturning({ hypotheses: [{ ...GOOD, statement: blamed }] }),
    });
    assert.deepEqual(out, [], 'these are real businesses; fail closed');
  });
}

test('blame hidden in refutes_if is caught too', async () => {
  const out = await propose({
    callModel: modelReturning({ hypotheses: [{
      ...GOOD,
      refutes_if: 'Establish that the operator did not deliberately conceal the case numbers from the district.',
    }] }),
  });
  assert.deepEqual(out, []);
});

test('a missing confirms_if or refutes_if is fatal', async () => {
  for (const field of ['confirms_if', 'refutes_if']) {
    const broken = { ...GOOD };
    delete broken[field];
    const out = await propose({ callModel: modelReturning({ hypotheses: [broken] }) });
    assert.deepEqual(out, [], `${field} is mandatory`);
  }
});

test('a vague test is not a test', async () => {
  for (const vague of [
    'Further investigation is required.',
    'More data would be needed to be sure of this.',
    'Investigate further with the relevant authorities.',
  ]) {
    const out = await propose({ callModel: modelReturning({ hypotheses: [{ ...GOOD, confirms_if: vague }] }) });
    assert.deepEqual(out, [], `"${vague}" has no failure condition`);
  }
});

test('identical confirms_if and refutes_if leave the claim untestable', async () => {
  const out = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, refutes_if: GOOD.confirms_if }] }),
  });
  assert.deepEqual(out, []);
});

test('an uncited hypothesis is dropped and a partly hallucinated one is trimmed', async () => {
  const none = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, document_ids: ['ghost-1', 'ghost-2'] }] }),
  });
  assert.deepEqual(none, [], 'no supplied evidence, no hypothesis');

  const [trimmed] = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, document_ids: ['d1', 'ghost-1'] }] }),
  });
  assert.deepEqual(trimmed.document_ids, ['d1'], 'only documents actually supplied are cited');
  assert.deepEqual(trimmed.document_urls, ['https://example.test/ship']);
});

test('entity keys that were not supplied are stripped, and an empty set is fatal', async () => {
  const [trimmed] = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, entity_keys: [SHIP, 'vessel:Invented'] }] }),
  });
  assert.deepEqual(trimmed.entity_keys, [SHIP]);

  const none = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, entity_keys: ['vessel:Invented'] }] }),
  });
  assert.deepEqual(none, []);
});

test('a URL that was never supplied is dropped', async () => {
  // Catches a model quoting a source out of its training data as evidence.
  const out = await propose({
    callModel: modelReturning({ hypotheses: [{
      ...GOOD,
      statement: `${GOOD.statement} See https://elsewhere.test/report for background.`,
    }] }),
  });
  assert.deepEqual(out, []);
});

test('a trivially short statement is dropped', async () => {
  const out = await propose({
    callModel: modelReturning({ hypotheses: [{ ...GOOD, statement: 'It may indicate something.' }] }),
  });
  assert.deepEqual(out, []);
});

test('non-object junk in the hypotheses array is skipped without taking the rest down', async () => {
  const out = await propose({
    callModel: modelReturning({ hypotheses: [null, 'nonsense', 42, GOOD] }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].statement, GOOD.statement);
});
