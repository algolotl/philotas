// test/ontology-score.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCandidates, ACCEPT_THRESHOLD, REJECT_THRESHOLD } from '../lib/ontology/score.js';
// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
// `bge_8005` is the service identity the adapter composes from the host; every
// stub in this file routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';

const candidates = [
  { headline: 'Container ship berths at Port Botany', entity: 'Berth: Brotherson Dock 10', hint: 'berth in headline' },
  { headline: 'Container ship berths at Port Botany', entity: 'Vessel: FRESHWATER', hint: 'vessel name in headline' },
  { headline: 'Container ship berths at Port Botany', entity: 'Vessel: OOCL SHANGHAI', hint: 'vessel name in headline' },
];

// Logits chosen to land either side of the thresholds after the sigmoid:
//   4.0  -> 0.982  ACCEPT
//  -4.0  -> 0.018  REJECT
//   0.0  -> 0.500  BAND
//
// scoreCandidates sends one document per rerank() call, so the real endpoint
// replies with exactly one result, tagged index: 0 (verified against
// the reference rerank endpoint directly). The stub mirrors that: each call advances to the
// next logit and hands back a single-result response for it.
const stub = (logits) => {
  let call = 0;
  return async () => ({
    ok: true,
    json: async () => ({ results: [{ index: 0, relevance_score: logits[call++] }] }),
  });
};

test('scores above the accept threshold become links', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub([4.0, -4.0, 0.0]);
  try {
    const { verdicts, banded } = await scoreCandidates(candidates);
    const byIndex = Object.fromEntries(verdicts.map((v) => [v.i, v]));
    assert.equal(byIndex[0].keep, true);
    assert.equal(byIndex[0].method, 'cross-encoder');
    assert.ok(byIndex[0].confidence > 0.98);
    assert.equal(byIndex[1].keep, false, 'below the reject threshold');
    assert.equal(banded, 1, 'the mid-range candidate is banded, not decided');
    assert.equal(byIndex[2], undefined, 'a banded candidate produces no verdict');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a banded candidate is never emitted as a link', async () => {
  // Until calibration lands (a later plan), the uncertainty band is reported
  // and dropped. Emitting it on a guess is the behaviour this design removes.
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub([0.1, -0.1, 0.2]);
  try {
    const { verdicts, banded } = await scoreCandidates(candidates);
    assert.equal(verdicts.length, 0);
    assert.equal(banded, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unavailable reranker degrades without inventing links', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    const { verdicts, degraded } = await scoreCandidates(candidates);
    assert.deepEqual(verdicts, [], 'no links are asserted when nothing scored them');
    assert.equal(degraded, 'rerank-unavailable');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no candidates means no network call and no degradation', async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return { ok: true, json: async () => ({ results: [] }) }; };
  try {
    const { verdicts, banded, degraded } = await scoreCandidates([]);
    assert.deepEqual(verdicts, []);
    assert.equal(banded, 0);
    assert.equal(degraded, null);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the thresholds are ordered and inside the probability range', async () => {
  assert.ok(ACCEPT_THRESHOLD > REJECT_THRESHOLD);
  assert.ok(REJECT_THRESHOLD > 0 && ACCEPT_THRESHOLD < 1);
});

test('the provisional threshold band is 0.20 to 0.80, and moving it is a decision', async () => {
  // Measured 2026-08-17 by mutation: REJECT_THRESHOLD 0.20 → 0.05 left all 603
  // tests green. The assertion above imports both constants and checks only their
  // RELATIONS, and 0.05 satisfies every one of them — so the reject arm of the
  // link-acceptance gate, the value deciding what the semantic layer discards,
  // could move by a factor of four with nothing noticing. ACCEPT_THRESHOLD was
  // pinned only incidentally, by another test using a literal score, which is the
  // kind of accidental pin that rots the first time that test is rewritten.
  //
  // These are the PROVISIONAL values lib/ontology/score.js documents as
  // deliberately wide, pending derivation from a hand-labelled gold set with a
  // reported AUC. Narrowing the band is exactly the change that must not happen
  // by accident: it converts declines-to-decide into decisions, and the band being
  // wide is the only thing currently standing in for calibration.
  assert.equal(REJECT_THRESHOLD, 0.20);
  assert.equal(ACCEPT_THRESHOLD, 0.80);
});
