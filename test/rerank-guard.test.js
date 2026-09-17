// test/rerank-guard.test.js
//
// lib/rerank.js's own `Number.isFinite` loop, exercised directly.
//
// WHY THIS FILE EXISTS. Every other test of that loop stubs `globalThis.fetch`
// and asserts through the real @axoquant/llm. That worked up to 0.2.1, which did
// no numeric validation — `scores[item.index] = item.relevance_score` straight
// from the parsed body — so whatever the stub put on the wire arrived at the loop
// unexamined. 0.3.0 validates `relevance_score` in its own readScores() and
// throws MalformedResponse first, which means the loop is no longer reachable
// through a `fetch` stub at all: test/rerank.test.js now pins how parallax
// CLASSIFIES the client's refusal, and nothing there touches the loop.
//
// The loop is deliberate defence in depth — the client is pinned by commit, so a
// downgrade to a version without the check is an edit to package.json rather than
// an event anyone would notice — but a guard no test can reach is a guard nobody
// can prove works, and it rots. So the seam moves one layer out: the CLIENT's
// exported rerank() is replaced, because the client is what now intercepts.
//
// HOW. A `node:module` resolve hook registered as a data URL, the technique
// test/corpus-search-route.test.js uses for the "@/" alias and
// test/ontology-route.test.js uses for JSON import attributes. It adds no
// dependency. Two things it has to get right:
//
//   - Keyed on the IMPORTER, not on the specifier alone. Only lib/rerank.js's
//     copy of ../llm.js is replaced; every other importer keeps the real adapter.
//   - Registered before the module under test is loaded. Static imports resolve
//     during linking, before any module body runs, so lib/rerank.js is pulled in
//     with a top-level `await import()` AFTER register() — a static import here
//     would be resolved before the hook existed.
//
// AND THE CONTROL. `globalThis.fetch` throws for the whole file. If the hook ever
// stops applying, the real client runs, reaches that fetch and raises
// RerankUnavailable/'transport' — so a seam that is not installed shows up as a
// red test rather than as coverage that quietly moved back to the adapter. The
// last test in the file asserts exactly that, which also pins that the seam is
// transparent when no test has installed anything.
//
// Nothing here reaches a network or a database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const realLlmUrl = import.meta.resolve('../lib/llm.js');

// Delegates unless a test installs scores, so the seam cannot make the module
// under test pass by accident: with nothing installed lib/rerank.js talks to the
// real adapter exactly as it does in production.
const clientSeamSource = `
  import { rerank as realRerank } from ${JSON.stringify(realLlmUrl)};
  export * from ${JSON.stringify(realLlmUrl)};
  export async function rerank(query, documents, opts) {
    const seam = globalThis.__parallaxRerankClientSeam;
    if (seam) return { scores: seam.scores };
    return realRerank(query, documents, opts);
  }
`;
const clientSeamUrl = `data:text/javascript,${encodeURIComponent(clientSeamSource)}`;

const resolverSource = `
  const seamUrl = ${JSON.stringify(clientSeamUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === './llm.js' && (context.parentURL || '').endsWith('/lib/rerank.js')) {
      return { url: seamUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(resolverSource)}`, import.meta.url);

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('test/rerank-guard.test.js reaches no network: the client seam should have answered');
};
after(() => {
  globalThis.fetch = previousFetch;
});

const { rerank, RerankMalformed } = await import('../lib/rerank.js');

/** Run `fn` with the client returning `scores` instead of calling the service. */
const withClientScores = async (scores, fn) => {
  globalThis.__parallaxRerankClientSeam = { scores };
  try {
    return await fn();
  } finally {
    delete globalThis.__parallaxRerankClientSeam;
  }
};

// Every row is a value the client would refuse itself in the pinned version, and
// did NOT refuse in 0.2.1. The message asserted is lib/rerank.js's own — `index N
// scored <String(v)> (<typeof v>)`, unquoted — which is how these assertions stay
// distinguishable from the client's, whose text for the last row quotes the string
// and continues 'which is not a finite number'. A test that passed on the client's
// message would not be reaching the loop.
const rows = [
  // label                    scores      expected tail of parallax's own message
  ['NaN', [NaN], 'index 0 scored NaN (number)'],
  ['+Infinity', [Infinity], 'index 0 scored Infinity (number)'],
  ['-Infinity', [-Infinity], 'index 0 scored -Infinity (number)'],
  ['null', [null], 'index 0 scored null (object)'],
  ['undefined', [undefined], 'index 0 scored undefined (undefined)'],
  ['numeric string', ['0.5'], 'index 0 scored 0.5 (string)'],
];

for (const [label, scores, expected] of rows) {
  test(`lib/rerank.js's own loop refuses ${label} even when the client hands it through`, async () => {
    // KILLS: deleting the `Number.isFinite` loop from lib/rerank.js, and writing
    // it as `typeof logit === 'number'` (true for NaN and both Infinities, so
    // sigmoid would answer NaN, a confident 1 and a confident 0), and as a
    // falsiness test (which would also reject a genuine 0 — pinned below).
    await withClientScores(scores, async () => {
      await assert.rejects(
        () => rerank('q', ['a']),
        (err) => {
          assert.equal(err instanceof RerankMalformed, true, `${label}: its own class`);
          assert.equal(err.unavailable, true, `${label}: lib/corpus/search.js degrades on this tag`);
          assert.equal(err.malformed, true);
          assert.equal(err.reason, 'malformed-response');
          assert.equal(
            err.message,
            `rerank malformed response: ${expected}`,
            `${label}: this file's own wording, so it cannot pass on the client's`,
          );
          return true;
        },
      );
    });
  });
}

test("lib/rerank.js's own loop refuses a hole, which .every() and .forEach() would skip", async () => {
  // KILLS: rewriting the plain indexed loop as `logits.every(Number.isFinite)`
  // or `logits.forEach(...)`. Both SKIP holes, so the missing score would sigmoid
  // to NaN and be returned as a well-formed result. A hole is what a client
  // leaves at any position it did not write: 0.2.1 padded those with 0.0, which
  // is itself a genuine confident-non-match score, and 0.3.0 refuses the short
  // list rather than inventing one — a downgraded client is exactly the case this
  // loop is here to survive.
  const holed = new Array(3);
  holed[0] = 1.0;
  holed[2] = -1.0;
  // Self-check on the fixture: a dense [1, undefined, -1] would still be refused
  // by an .every() rewrite, so this test would stop killing that mutation
  // without anyone noticing.
  assert.equal(1 in holed, false, 'position 1 must be a hole, not an explicit undefined');
  assert.equal(holed.length, 3);

  await withClientScores(holed, async () => {
    await assert.rejects(
      () => rerank('q', ['a', 'b', 'c']),
      (err) => {
        assert.equal(err.malformed, true);
        assert.equal(err.message, 'rerank malformed response: index 1 scored undefined (undefined)');
        return true;
      },
    );
  });
});

test("lib/rerank.js's own loop refuses the whole batch rather than dropping the one bad document", async () => {
  // KILLS: filtering the bad entries out (`logits.filter(Number.isFinite)`) or
  // mapping them to a default. Either returns a well-formed, silently shorter
  // list — the invisible degrade this guard exists to remove — and a NaN sort key
  // corrupts the relative order of the VALID entries too, so there is no
  // salvageable ordering to return. Measured 2026-08-17 on node v22.22.2: over
  // 5,000 randomly ordered batches of 50 carrying exactly one non-numeric logit,
  // 1,805 (36.1%) came back with the valid entries misordered, against 0 of the
  // same 5,000 with all-numeric logits.
  await withClientScores([2.0, -3.0, null, 0.25, -1.0], async () => {
    await assert.rejects(
      () => rerank('q', ['a', 'b', 'c', 'd', 'e']),
      (err) => {
        assert.equal(err.malformed, true);
        assert.equal(err.reason, 'malformed-response');
        assert.equal(
          err.message,
          'rerank malformed response: index 2 scored null (object)',
          'the offending position, named by this file, so it is not a guessing game',
        );
        return true;
      },
    );
  });
});

test("lib/rerank.js's own loop accepts a genuine zero and scores it exactly 0.5", async () => {
  // KILLS: writing the guard as a falsiness test (`if (!logit) throw`) or as
  // `logit || ...`. 0.0 is a real reranker output — a confident non-match — so
  // rejecting it would turn every legitimate low score into a hard failure. The
  // literal 0.5 is pinned rather than recomputed, so this fails if sigmoid is
  // changed as well as if the guard is.
  await withClientScores([0], async () => {
    const out = await rerank('q', ['a']);
    assert.equal(out.length, 1);
    assert.equal(out[0].logit, 0);
    assert.equal(out[0].score, 0.5);
  });
});

test('with nothing installed the seam delegates to the real client, so these tests cannot pass on a blocked fetch', async () => {
  // THE CONTROL for every test above. If the resolve hook stopped applying, or
  // the seam stopped delegating, lib/rerank.js would reach the file-level fetch
  // block and raise the outage class — which is exactly what this test asserts
  // happens when no scores are installed. It fails if the seam is faking
  // unconditionally, and the tests above fail if the seam is not installed at
  // all, so NOT APPLIED and SURVIVED cannot be confused.
  assert.equal(globalThis.__parallaxRerankClientSeam, undefined);
  await assert.rejects(
    () => rerank('q', ['a']),
    (err) => {
      assert.equal(err.malformed, undefined, 'a blocked fetch is an outage, not a contract break');
      assert.equal(err.unavailable, true);
      assert.equal(err.reason, 'transport');
      assert.match(err.message, /reaches no network/, "the file's own fetch block is what answered");
      return true;
    },
  );
});
