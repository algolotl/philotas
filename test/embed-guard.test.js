// test/embed-guard.test.js
//
// lib/embed.js's own EMBED_DIM shape check, exercised directly.
//
// WHY THIS FILE EXISTS. test/embed.test.js stubs `globalThis.fetch` and asserts
// through the real @axoquant/llm. For the MODEL PROBE that is still the right
// seam and nothing here duplicates it: GET /v1/models is parallax's own request,
// the client has no such call, and every one of that probe's five refusals
// (no `data` array, an empty list, a second entry, an unusable `id`, an
// `meta.n_embd` that disagrees with EMBED_DIM) is reached from a `fetch` stub
// exactly as it always was.
//
// The per-vector shape check is the half that moved. Measured 2026-08-18 against
// the pinned @axoquant/llm 0.3.0 by handing its readVectors()
// (node_modules/@axoquant/llm/js/client.js:445-486) twelve bodies through a
// `fetch` stub: ten were REFUSED with MalformedResponse — a short list, a row
// count below the input count, an index outside the batch, a duplicate index, an
// absent index, an embedding that is a string, null, or absent, a null
// component, and a hole inside the embedding — and the only two that came back
// were dense arrays of finite numbers. So through a `fetch` stub the ONLY thing
// about a vector that can still be wrong is its LENGTH, which
// test/embed.test.js's 'a wrong-dimension vector is rejected rather than stored'
// still reaches. Everything else the check is written to catch — a missing
// vector, a vector that is not an array — is now unreachable that way, and an
// unreachable guard is one nobody can prove works.
//
// It matters that it is proved rather than assumed. Making it reachable is what
// found that `vectors.forEach(...)` SKIPS holes, so the `v?.length` optional
// chaining that check is written with could never fire: a sparse result array
// passed the guard silently and `undefined` went on to the VECTOR column. That
// is the same defect lib/rerank.js is written against with a plain indexed loop,
// and no `fetch`-level test could have seen it.
//
// HOW. A `node:module` resolve hook registered as a data URL — the technique
// test/rerank-guard.test.js uses for this same client, test/corpus-search-route.
// test.js uses for the "@/" alias and test/ontology-route.test.js uses for JSON
// import attributes. It adds no dependency. Three things it has to get right:
//
//   - Keyed on the IMPORTER, not on the specifier alone. Only lib/embed.js's
//     copy of ../llm.js is replaced; every other importer keeps the real adapter.
//   - The seam re-exports `embedEndpoint`. lib/embed.js derives the tokenizer
//     and probe origins from the adapter's embed endpoint, so a seam that
//     replaced the module wholesale would break that resolution.
//   - Registered before the module under test is loaded. Static imports resolve
//     during linking, before any module body runs, so lib/embed.js is pulled in
//     with a top-level `await import()` AFTER register() — a static import here
//     would be resolved before the hook existed.
//
// AND THE CONTROL. `globalThis.fetch` answers GET /v1/models and NOTHING else
// for the whole file. The probe is parallax's own code and is what these tests
// have to get past to reach the vectors; every other URL — which means the
// adapter's POST to the embeddings endpoint — throws. So if the hook ever stops
// applying, the real adapter runs, reaches that block and raises
// EmbedUnavailable/'transport', and the tests below go red rather than quietly
// handing their coverage back to the client. The last test asserts exactly that,
// which also pins that the seam is transparent when no test has installed
// anything.
//
// Nothing here reaches a network or a database.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const realLlmUrl = import.meta.resolve('../lib/llm.js');

// Delegates unless a test installs vectors, so the seam cannot make the module
// under test pass by accident: with nothing installed lib/embed.js talks to the
// real adapter exactly as it does in production. `embedEndpoint` is re-exported
// straight through — the probe/tokenizer origin resolution is not what is being
// replaced, only the vectors.
const clientSeamSource = `
  import { embed as realEmbed } from ${JSON.stringify(realLlmUrl)};
  export * from ${JSON.stringify(realLlmUrl)};
  export async function embed(texts, opts) {
    const seam = globalThis.__parallaxEmbedClientSeam;
    if (seam) return { vectors: seam.vectors };
    return realEmbed(texts, opts);
  }
`;
const clientSeamUrl = `data:text/javascript,${encodeURIComponent(clientSeamSource)}`;

const resolverSource = `
  const seamUrl = ${JSON.stringify(clientSeamUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === './llm.js' && (context.parentURL || '').endsWith('/lib/embed.js')) {
      return { url: seamUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(resolverSource)}`, import.meta.url);

// What the embedder's /v1/models answered, probed 2026-08-17. The probe is parallax's
// own request and stays real here; it is the vectors that are seamed.
const ONE_MODEL_BODY = {
  object: 'list',
  data: [{
    id: 'bge-m3',
    object: 'model',
    owned_by: 'llamacpp',
    meta: { n_embd: 1024, n_ctx: 8192, n_vocab: 250002 },
  }],
};

const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/v1/models')) return { ok: true, status: 200, json: async () => ONE_MODEL_BODY };
  throw new Error(
    `test/embed-guard.test.js reaches no network: the client seam should have answered before ${u}`,
  );
};
after(() => {
  globalThis.fetch = previousFetch;
});

const { embed, EMBED_DIM, _resetModelProbe } = await import('../lib/embed.js');
// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
// `bge_8005` is the service identity the adapter composes from the host; every
// stub in this file routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';

// The probe is cached per process, so without this a test that ran after a
// failure would read whatever the previous one left behind.
beforeEach(() => _resetModelProbe());

const vec = (n) => Array.from({ length: EMBED_DIM }, () => n);

/** Run `fn` with the client returning `vectors` instead of calling the service. */
const withClientVectors = async (vectors, fn) => {
  globalThis.__parallaxEmbedClientSeam = { vectors };
  try {
    return await fn();
  } finally {
    delete globalThis.__parallaxEmbedClientSeam;
  }
};

test("lib/embed.js's own check refuses a hole, which .forEach() and .every() skip", async () => {
  // KILLS: writing the check as `vectors.forEach(...)` — which is what it was
  // until this test existed — or as `.every()` or `.map()`. All three SKIP holes,
  // so a missing vector passed the guard untouched and `undefined` went on to be
  // joined into a VECTOR(1024) literal. That is not a hypothetical shape: it is
  // what any client leaves at a position it did not write, and the `v?.length`
  // optional chaining the check is written with exists for exactly this value —
  // it could never fire, because .forEach() never handed it one.
  //
  // Also KILLS deleting the check outright, and rewriting `v?.length` as
  // `v.length` (a bare TypeError naming neither the layer nor the input, and
  // carrying no `.dimension` tag).
  const holed = new Array(3);
  holed[0] = vec(0.1);
  holed[2] = vec(0.3);
  // Self-check on the fixture: a dense [v, undefined, v] would still be refused
  // by a .forEach() implementation, so this test would stop killing that
  // mutation without anyone noticing.
  assert.equal(1 in holed, false, 'position 1 must be a hole, not an explicit undefined');
  assert.equal(holed.length, 3);

  await withClientVectors(holed, async () => {
    await assert.rejects(
      () => embed(['a', 'b', 'c']),
      (err) => {
        assert.equal(err.dimension, true, 'the tag that says this is a defect and not an outage');
        assert.equal(err.unavailable, undefined, 'degrading past a missing vector would store it');
        assert.equal(
          err.message,
          'embedding for input 1 has the wrong shape: expected 1024 dimensions, got undefined',
          "this file's own wording, naming the position, so it is not a guessing game",
        );
        return true;
      },
    );
  });
});

test("lib/embed.js's own check refuses an explicitly undefined vector", async () => {
  // KILLS: deleting the check, and rewriting `v?.length !== EMBED_DIM` as
  // `v.length !== EMBED_DIM`. The dense case is the one the optional chaining
  // handles today; the hole above is the one it could not reach. Both must name
  // the input and carry `.dimension`.
  await withClientVectors([vec(0.1), undefined], async () => {
    await assert.rejects(
      () => embed(['a', 'b']),
      (err) => {
        assert.equal(err.dimension, true);
        assert.equal(
          err.message,
          'embedding for input 1 has the wrong shape: expected 1024 dimensions, got undefined',
        );
        return true;
      },
    );
  });
});

test("lib/embed.js's own check refuses the whole batch rather than storing the good vectors and dropping the bad one", async () => {
  // KILLS: filtering the bad entries out, or mapping them to a default. Either
  // returns a well-formed, silently SHORTER list, and lib/ontology/profiles.js
  // and lib/corpus/chunk.js both zip the returned vectors onto their own input
  // list BY POSITION — so a dropped vector does not merely lose one row, it
  // shifts every row after it onto the wrong text. The offending position is
  // named because the alternative is an operator guessing which of a 40-text
  // batch came back wrong.
  const batch = [vec(0.1), vec(0.2), [1, 2, 3], vec(0.4)];
  await withClientVectors(batch, async () => {
    await assert.rejects(
      () => embed(['a', 'b', 'c', 'd']),
      (err) => {
        assert.equal(err.dimension, true);
        assert.equal(
          err.message,
          'embedding for input 2 has the wrong shape: expected 1024 dimensions, got 3',
          'the first bad position, named, and the batch refused rather than trimmed',
        );
        return true;
      },
    );
  });
});

test("lib/embed.js's own check passes a correctly shaped batch through untouched", async () => {
  // KILLS: writing the check so it always throws, or inverting the comparison to
  // `v?.length === EMBED_DIM`. Also pins that the seam DELIVERS: a guard file
  // whose every test asserts a rejection would pass just as well against a seam
  // that always threw.
  const batch = [vec(0.1), vec(0.2)];
  const { vectors, service, embedModel } = await withClientVectors(batch, () => embed(['a', 'b']));
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0][0], 0.1, 'input order is preserved');
  assert.equal(vectors[1][0], 0.2);
  assert.equal(vectors[0].length, 1024, 'the literal, so this fails if EMBED_DIM and the fixtures drift together');
  assert.equal(service, 'bge_8005');
  assert.equal(embedModel, 'bge_8005:bge-m3', 'the model probe ran for real, through the file-level fetch');
});

test('with nothing installed the seam delegates to the real client, so these tests cannot pass on a blocked fetch', async () => {
  // THE CONTROL for every test above. If the resolve hook stopped applying, or
  // the seam stopped delegating, lib/embed.js would reach the file-level fetch
  // block on the client's POST and raise the outage class — which is exactly
  // what this test asserts happens when no vectors are installed. It fails if
  // the seam is faking unconditionally, and the tests above fail if the seam is
  // not installed at all, so NOT APPLIED and SURVIVED cannot be confused.
  assert.equal(globalThis.__parallaxEmbedClientSeam, undefined);
  await assert.rejects(
    () => embed(['a']),
    (err) => {
      assert.equal(err.dimension, undefined, 'a blocked fetch is an outage, not a wrong shape');
      assert.equal(err.malformed, undefined, 'nor a contract break');
      assert.equal(err.unavailable, true);
      assert.equal(err.reason, 'transport');
      assert.match(err.message, /reaches no network/, "the file's own fetch block is what answered");
      return true;
    },
  );
});

test('the model probe is NOT seamed, so its own guards are still reached through fetch', async () => {
  // Pins the boundary this file draws. GET /v1/models is parallax's own request
  // and the client has no equivalent, so the probe's refusals stay in
  // test/embed.test.js against a `fetch` stub. If someone later routed the probe
  // through the client, this test goes red and that decision gets made
  // deliberately rather than by a resolve hook silently widening.
  const seen = [];
  const blocked = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    return blocked(url, init);
  };
  try {
    await withClientVectors([vec(0.1)], () => embed(['a']));
  } finally {
    globalThis.fetch = blocked;
  }
  const { embedEndpoint } = await import('../lib/llm.js');
  const origin = (await embedEndpoint()).origin;
  assert.deepEqual(seen, [`${origin}/v1/models`], 'the probe is real; the vectors are the only thing seamed');
});
