// test/rerank.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerank, RerankUnavailable, RerankMalformed } from '../lib/rerank.js';
import { scoreCandidates } from '../lib/ontology/score.js';
// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
// `bge_8005` is the service identity the adapter composes from the host; every
// stub in this file routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';

// bge-reranker-v2-m3 returns raw logits, not probabilities. Measured against
// the rerank endpoint on 2026-08-15 for the query "Container ship berths at Port Botany
// after delay":
//   "Berth: Brotherson Dock 10, Port Botany container terminal"   1.056
//   "Vessel: OOCL SHANGHAI, container ship, berth Brotherson 10"  -1.951
//   "Vessel: FRESHWATER, Sydney Ferries passenger ferry"          -9.722
// Thresholds in this system are calibrated probabilities, so the client
// converts with a sigmoid rather than leaving unbounded logits to the caller.
// Deliberately NOT in descending-score order: the middle logit arrives
// first. A test fixture that already arrives sorted cannot tell a working
// .sort() from a deleted one, since Array.prototype.map() alone would
// happen to reproduce the same order it was given.
const stubResponse = {
  results: [
    { index: 0, relevance_score: -1.951106309890747 },
    { index: 2, relevance_score: 1.0562665462493896 },
    { index: 1, relevance_score: -9.722463607788086 },
  ],
};

test('logits are converted to probabilities and sorted', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => stubResponse });
  try {
    const out = await rerank('q', ['a', 'b', 'c']);
    assert.equal(out.length, 3);
    // Pin the exact order, by index as well as by score, so this fails if
    // .sort() is removed: an unsorted map() would yield [0, 2, 1], not the
    // descending-score order [2, 0, 1] asserted here.
    assert.deepEqual(out.map((r) => r.index), [2, 0, 1], 'results are reordered to descending score, not left as received');
    assert.equal(out[0].index, 2);
    assert.ok(out[0].score > 0.74 && out[0].score < 0.75, `expected ~0.742, got ${out[0].score}`);
    assert.ok(out[1].score > 0.12 && out[1].score < 0.13, `expected ~0.124, got ${out[1].score}`);
    assert.ok(out[2].score < 0.001, `expected ~0.00006, got ${out[2].score}`);
    assert.equal(out[0].logit, 1.0562665462493896, 'the raw logit is preserved for debugging');
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].score >= out[i].score, 'results are sorted by score descending');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('topN cuts the sorted list, so the caller gets the top N and not the first N', async () => {
  // Truncation moved into lib/rerank.js on this branch. The old code sent
  // `top_n: topN ?? documents.length` and let the service cut; the shared
  // client sends no top_n, so the .slice() here is now the only thing doing it.
  // lib/corpus/search.js passes topN: limit (default 10) over LEG_LIMIT = 50
  // candidates, so losing that line returns 50 hits where 10 were asked for —
  // five times the payload, silently, on the corpus search path.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => stubResponse });
  try {
    const out = await rerank('q', ['a', 'b', 'c'], { topN: 2 });
    assert.equal(out.length, 2, 'topN: 2 over three documents must return two');
    // By index, not just by length: the cut has to happen AFTER the sort.
    // Slicing first would keep documents 0 and 1, and document 1 is the worst
    // of the three.
    assert.deepEqual(out.map((r) => r.index), [2, 0], 'the two highest-scoring, not the first two as received');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('no topN returns every document scored', async () => {
  // The other side of the same line: `topN ?? documents.length` must not cut
  // anything when the caller asked for nothing. lib/ontology/score.js relies on
  // the default, and a slice that defaulted to a fixed number would quietly
  // drop candidates.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => stubResponse });
  try {
    assert.equal((await rerank('q', ['a', 'b', 'c'])).length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an empty document list costs no network call', async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return { ok: true, json: async () => stubResponse }; };
  try {
    assert.deepEqual(await rerank('q', []), []);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unreachable endpoint raises a named error', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED'); };
  try {
    await assert.rejects(
      () => rerank('q', ['a']),
      (err) => err instanceof RerankUnavailable && err.unavailable === true
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a non-ok response raises the same named error', async () => {
  const realFetch = globalThis.fetch;
  // `text()` as well as `json()`: the shared client reads the body as text so
  // the service's own error detail reaches the message. A stub without it would
  // fail on the missing method rather than on the status.
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'no backend available',
    json: async () => ({}),
  });
  try {
    await assert.rejects(() => rerank('q', ['a']), (err) => err.unavailable === true && /503/.test(err.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// This file used to default to `http://localhost:8006/v1/rerank`. That works on
// one host because haproxy runs there, and fails everywhere else into a silent
// `.unavailable` degrade — the exact defect the adapter exists to remove. The
// two tests below fail if a host literal is ever reintroduced here.
test('the endpoint comes from the adapter, not from a literal in this file', async () => {
  const realFetch = globalThis.fetch;
  let seenUrl = null;
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ results: [{ index: 0, relevance_score: 0 }] }) };
  };
  try {
    await rerank('q', ['a']);
    assert.ok(seenUrl.endsWith('/v1/rerank'), 'the URL must be the adapter-resolved rerank endpoint');
    assert.ok(!/localhost/.test(seenUrl), 'localhost is never the right answer off a configured host');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('every call is attributed, so a slow path can be costed at the gateway', async () => {
  const realFetch = globalThis.fetch;
  let seenApp = null;
  globalThis.fetch = async (_url, init) => {
    seenApp = init?.headers?.['X-Algolotl-App'];
    return { ok: true, status: 200, json: async () => ({ results: [{ index: 0, relevance_score: 0 }] }) };
  };
  try {
    await rerank('q', ['a'], { app: 'philotas/entities' });
    assert.equal(seenApp, 'philotas/entities', 'unattributed calls log as "-" and cannot be costed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// Non-finite logits, as classified by this file.
//
// Through a `fetch` stub these tests no longer reach lib/rerank.js's own
// validation loop. @axoquant/llm 0.3.0 validates `relevance_score` in its
// readScores() (node_modules/@axoquant/llm/js/client.js:348-383) and throws its
// own MalformedResponse, tagged `.malformed`, before any value reaches philotas.
// Up to 0.2.1 it did no numeric validation at all — `scores[item.index] =
// item.relevance_score` straight from the parsed body — and philotas's loop was
// the only thing between the wire and a stored link decision.
//
// So what these tests pin is now the CLASSIFICATION: a refusal raised by the
// CLIENT must reach a caller as RerankMalformed with `.reason ===
// 'malformed-response'`, not flattened into the outage class by the catch in
// lib/rerank.js. philotas's own loop is still there and still refuses each of
// these values itself; it is reached by replacing the client's exported rerank()
// in test/rerank-guard.test.js, which is the only seam left now that the client
// intercepts first.
//
// What sigmoid() would do with each shape if BOTH guards were absent:
//   "0.5"      -> 0.6225  unary minus coerces the string; silently plausible
//   null       -> 0.5     -null is 0; a confident-looking mid-band score
//   undefined  -> NaN     a missing relevance_score key, or an index hole
//   NaN        -> NaN
//   +Infinity  -> 1       a confident ACCEPT
//   -Infinity  -> 0       a confident REJECT
// Only the first three are reachable through JSON.parse, which rejects the
// bare NaN/Infinity tokens Python's json.dumps emits. The last three are
// covered anyway because they are exactly the values `typeof x === 'number'`
// waves through, and two of them turn into confident wrong answers.
const stubLogit = (value) => async () => ({
  ok: true,
  status: 200,
  // `index` present, `relevance_score` set to the shape under test. Omitting
  // the key entirely is the `undefined` row.
  json: async () => ({ results: [value === undefined ? { index: 0 } : { index: 0, relevance_score: value }] }),
});

const withFetch = async (stub, fn) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};

test('a non-numeric relevance_score the client refused is classified as malformed, not as an outage', async () => {
  // KILLS: dropping the `err.malformed` re-throw from the catch in
  // lib/rerank.js. The client refuses the string "0.5" itself, so without the
  // re-throw its MalformedResponse is flattened into RerankUnavailable with
  // `.reason = 'transport'` and an operator is sent to check a service that is
  // up and answering.
  await withFetch(stubLogit('0.5'), async () => {
    await assert.rejects(
      () => rerank('q', ['a']),
      (err) => {
        assert.equal(err instanceof RerankMalformed, true, 'its own class, not the outage class');
        assert.equal(err.unavailable, true, 'lib/corpus/search.js:159 and lib/ontology/score.js:60 both branch on .unavailable');
        assert.equal(err.malformed, true);
        assert.equal(err.reason, 'malformed-response', 'literal pinned, not imported from the module under test');
        // THIS file's own prefix, which is the assertion that does the work: the
        // client's detail below reads identically under either classification,
        // because RerankUnavailable would wrap the same text with 'rerank
        // unavailable: '.
        assert.match(err.message, /^rerank malformed response: /, 'philotas says which of its own two states this is');
        // The client's wording, asserted for PRESERVATION rather than for
        // classification: an operator still needs to know which document came
        // back wrong and in what shape, and re-wrapping must not discard it.
        assert.match(err.message, /index 0/, 'which document came back wrong survives the re-wrap');
        assert.match(err.message, /string/, 'and what shape it came back as');
        return true;
      },
    );
  });
});

test('each non-finite logit shape refused by the client is classified as malformed, including the two sigmoid would answer confidently', async () => {
  // KILLS: the same missing re-throw, across every shape rather than one. The
  // client's own check is `Number.isFinite`, so NaN, +Infinity and -Infinity are
  // refused there too — and if either layer were written as
  // `typeof score === 'number'` those three would pass and sigmoid would return
  // NaN, 1 and 0, the last two being confident wrong answers rather than errors.
  // That each value is refused BY PHILOTAS'S OWN LOOP is a different claim, and
  // it is pinned in test/rerank-guard.test.js against the same six rows.
  const rows = [
    ['NaN', NaN],
    ['+Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['null', null],
    ['undefined (key absent)', undefined],
    ['numeric string', '0.5'],
  ];
  for (const [label, value] of rows) {
    await withFetch(stubLogit(value), async () => {
      await assert.rejects(
        () => rerank('q', ['a']),
        (err) => {
          assert.equal(err instanceof RerankMalformed, true, `${label} must be refused as malformed`);
          assert.equal(err.reason, 'malformed-response', `${label} must not read as an outage`);
          assert.equal(err.malformed, true, `${label} must carry the tag callers switch on`);
          return true;
        },
        `${label} must be refused`,
      );
    });
  }
});

test('a genuine zero logit is a valid score of exactly 0.5, not a malformed response', async () => {
  // KILLS: writing either guard as a falsiness test (`if (!logit) throw`) or as
  // `logit || ...`. 0.0 is a real reranker output — a confident non-match — and
  // it is exactly why @axoquant/llm 0.3.0 stopped padding an unscored index with
  // it and refuses the short list instead. Rejecting it here would turn every
  // legitimate low score into a hard failure.
  await withFetch(stubLogit(0), async () => {
    const out = await rerank('q', ['a']);
    assert.equal(out.length, 1);
    assert.equal(out[0].logit, 0);
    assert.equal(out[0].score, 0.5, 'sigmoid(0) is exactly 0.5 — the literal, so this pins the value and not the formula');
  });
});

test('one score the client refused refuses the whole batch rather than quietly dropping that document', async () => {
  // KILLS: the missing `err.malformed` re-throw again, on a batch rather than a
  // single document — this is the shape the corpus search path actually sends.
  // The refusal itself comes from the client here; that philotas's own loop
  // refuses the whole batch rather than filtering the bad entries out
  // (`logits.filter(Number.isFinite)`) or mapping them to a default is pinned in
  // test/rerank-guard.test.js.
  //
  // Measured 2026-08-17 on node v22.22.2, reproducing lib/rerank.js:69-72 with
  // `(a, b) => b.score - a.score`: over 5,000 randomly ordered batches of 50
  // carrying exactly one non-numeric logit, 1,805 (36.1%) came back with the
  // VALID entries in the wrong relative order; the same 5,000 batches with
  // all-numeric logits misordered 0 times. In 212 of them the corruption
  // reached ranks 0-9, the slice lib/corpus/search.js keeps at its default
  // topN of 10; the worst case had 47 of 49 valid entries out of place and the
  // earliest divergence was at rank 0. A NaN score does not merely misplace
  // itself, so there is no salvageable ordering to return.
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 2.0 },
          { index: 1, relevance_score: -3.0 },
          { index: 2, relevance_score: null },
          { index: 3, relevance_score: 0.25 },
          { index: 4, relevance_score: -1.0 },
        ],
      }),
    }),
    async () => {
      await assert.rejects(
        () => rerank('q', ['a', 'b', 'c', 'd', 'e']),
        (err) => {
          assert.equal(err.malformed, true);
          assert.equal(err.reason, 'malformed-response', 'not the outage reason');
          assert.match(err.message, /^rerank malformed response: /, "philotas's own prefix, not the client's text alone");
          assert.match(err.message, /index 2/, 'the offending position survives the re-wrap, so it is not a guessing game');
          return true;
        },
      );
    },
  );
});

test('a malformed response is distinguishable from an outage, so nobody is sent to check a service that is answering', async () => {
  // KILLS: reusing `new RerankUnavailable(...)` for the malformed case, which
  // since @axoquant/llm 0.3.0 means dropping the `err.malformed` re-throw from
  // the catch — the client refuses first, so every malformed response arrives at
  // that catch and nothing else distinguishes it. Both errors must keep
  // .unavailable === true so callers still degrade by name, but collapsing them
  // makes "the scorer replied with nonsense" read as "the scorer is down" in the
  // logs. Literals pinned on both sides.
  //
  // Both legs go through the same `fetch` stub, so this is a comparison of two
  // classifications of the same layer's failures, not of two layers.
  const outage = await withFetch(
    async () => { throw new Error('connect ECONNREFUSED'); },
    () => rerank('q', ['a']).then(() => null, (e) => e),
  );
  const malformed = await withFetch(stubLogit(null), () => rerank('q', ['a']).then(() => null, (e) => e));

  assert.equal(outage.unavailable, true);
  assert.equal(malformed.unavailable, true);
  assert.equal(outage.name, 'RerankUnavailable');
  assert.equal(malformed.name, 'RerankMalformed');
  assert.equal(outage.reason, 'transport');
  assert.equal(malformed.reason, 'malformed-response');
  assert.equal(malformed instanceof RerankUnavailable, false, 'not a subtype of the outage, or `instanceof` misreports it');
  // The two messages must not read alike either: this is what an operator sees.
  assert.match(outage.message, /^rerank unavailable: /);
  assert.match(malformed.message, /^rerank malformed response: /);
});

test('a malformed response reaches the operator as a degrade, not as an inflated band count', async () => {
  // Consequence 1, end to end through the real lib/ontology/score.js. That
  // module's only import is ../rerank.js, so this runs without a database.
  //
  // KILLS: throwing an error that is NOT tagged .unavailable. score.js:60
  // rethrows anything untagged, which 500s the caller; and before the guard
  // existed sigmoid(null) === 0.5 sits inside the 0.20-0.80 band, so the
  // candidate was recorded as `banded: 1` — "the model was uncertain" — when
  // the truth was "the upstream sent nonsense". Both literals pinned.
  await withFetch(stubLogit(null), async () => {
    const out = await scoreCandidates([{ entity: 'OOCL SHANGHAI', headline: 'Container ship berths at Port Botany' }]);
    assert.deepEqual(out.verdicts, [], 'no link is asserted either way');
    assert.equal(out.banded, 0, 'a malformed upstream must not be logged as model uncertainty');
    assert.equal(out.degraded, 'rerank-unavailable', 'the signal that is missing today');
  });
});
