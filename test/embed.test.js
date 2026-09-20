// test/embed.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { embed, countTokens, EmbedUnavailable, EmbedMalformed, EMBED_DIM, _resetModelProbe } from '../lib/embed.js';

// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
//
// The host is the service identity the embed_model assertions below expect. The
// adapter composes that identity from the host, and every stub in this file
// routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';

const vec = (n) => Array.from({ length: EMBED_DIM }, () => n);

// What the embedder's /v1/models actually answered, probed 2026-08-17. One entry,
// because llama.cpp serves one model per port; `meta.n_embd` is the dimension
// the server is really serving, as opposed to the one this file hopes for.
const servedModels = (data) => ({
  object: 'list',
  models: data,
  data,
});
const ONE_MODEL = [{
  id: 'bge-m3',
  aliases: ['bge-m3'],
  object: 'model',
  owned_by: 'llamacpp',
  meta: { n_embd: 1024, n_ctx: 8192, n_vocab: 250002 },
}];

/**
 * A fetch stub that ROUTES BY URL. The model probe, the embeddings call and the
 * tokenizer are three different endpoints, and a stub that answered all three
 * with one body would let a probe reading the wrong field pass — the failure
 * mode this whole task exists to close. Anything unrouted throws, so a new
 * network call cannot appear unnoticed.
 */
function routedFetch({ models = ONE_MODEL, embeddings, tokens, seen } = {}) {
  return async (url, init) => {
    const u = String(url);
    seen?.push({ url: u, init });
    if (u.endsWith('/v1/models')) {
      if (models instanceof Error) throw models;
      return { ok: true, json: async () => (Array.isArray(models) ? servedModels(models) : models) };
    }
    if (u.endsWith('/v1/embeddings')) {
      if (embeddings instanceof Error) throw embeddings;
      return { ok: true, json: async () => embeddings ?? { model: 'bge-m3', data: [{ index: 0, embedding: vec(0.1) }] } };
    }
    if (u.endsWith('/tokenize')) {
      if (tokens instanceof Error) throw tokens;
      return { ok: true, json: async () => ({ tokens: new Array(tokens ?? 0).fill(0) }) };
    }
    throw new Error(`unrouted fetch in test: ${u}`);
  };
}

// The probe is cached per process, so a test that does not reset it reads
// whatever the previous test in this file happened to serve. Every test below
// that touches the probe goes through here.
const withFetch = async (stub, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  _resetModelProbe();
  try { return await fn(); } finally { globalThis.fetch = real; _resetModelProbe(); }
};

test('embed_model is the service and the served model joined, and the format is the literal bge_8005:bge-m3', async () => {
  // The defect: embed_model was the registry SERVICE identity alone (`bge_8005`),
  // which is a serving endpoint and not a model. Re-point the same service at a
  // different 1024-dimension model — an in-place embedder upgrade on the same
  // role and port — and embed_model does not change, the dense leg's
  // `embed_model = $3` predicate matches both spaces, and cosine distance across
  // them returns confident nonsense. EMBED_DIM cannot catch it: both are 1024.
  //
  // The expected value is a LITERAL, not `${service}:${model}` recomputed from
  // the same sources the implementation reads. Deriving it would pin the
  // composition and leave the FORMAT free to drift to `bge_8005/bge-m3` or
  // `bge-m3` alone with nothing noticing.
  const { vectors, service, embedModel } = await withFetch(routedFetch({}), () => embed(['x']));
  assert.equal(embedModel, 'bge_8005:bge-m3');
  assert.equal(service, 'bge_8005', 'the service is still reported on its own, for callers that want the endpoint');
  assert.equal(vectors.length, 1);
});

test('two models on one endpoint is refused, not silently narrowed to the first', async () => {
  // The mutation this kills: `data[0].id`. llama.cpp serves one model per port
  // and the live probe returned exactly one entry, so `service:model` is a
  // faithful identity only while that holds. A second entry means the assumption
  // has broken, and picking the first would put two embedding spaces behind one
  // identifier — precisely the bug this task closes, resurrected one layer up.
  await withFetch(
    routedFetch({ models: [...ONE_MODEL, { id: 'e5-large-v2', meta: { n_embd: 1024 } }] }),
    async () => {
      await assert.rejects(
        () => embed(['x']),
        (err) =>
          err.name === 'EmbedModelAmbiguous' &&
          err.ambiguous === true &&
          !err.unavailable &&
          /bge-m3/.test(err.message) &&
          /e5-large-v2/.test(err.message)
      );
    }
  );
});

test('a model list that cannot name exactly one model is refused rather than guessed at', async () => {
  // Four malformed shapes, each of which would otherwise produce an embed_model
  // ending in `:undefined` and write it against real vectors. Named separately
  // from the ambiguous case: two models is a broken ASSUMPTION, these are a
  // broken ANSWER, and an operator reading the error needs to know which.
  // Each case carries the message fragment that DIAGNOSES it, not just the class.
  // Found on 2026-08-17 by a mutation canary: with only the class asserted, the
  // empty-list branch could be deleted and the suite stayed green — an empty list
  // fell through to the id check and raised the same class from the wrong branch.
  // An operator reading "no usable id" when the server actually served nothing at
  // all is being pointed at the wrong fault.
  const refused = [
    ['an empty list', [], /empty model list/],
    ['no data key at all', { object: 'list' }, /no `data` array/],
    ['data that is not an array', { data: 'bge-m3' }, /no `data` array/],
    ['an entry with no id', [{ object: 'model', meta: { n_embd: 1024 } }], /no usable `id`/],
    ['a non-string id', [{ id: 1024, meta: { n_embd: 1024 } }], /no usable `id`.*1024/],
    ['an empty-string id', [{ id: '', meta: { n_embd: 1024 } }], /no usable `id`/],
  ];
  for (const [label, models, diagnosis] of refused) {
    await withFetch(routedFetch({ models }), async () => {
      await assert.rejects(
        () => embed(['x']),
        (err) =>
          err.name === 'EmbedModelUnidentifiable' &&
          !err.unavailable &&
          diagnosis.test(err.message),
        `${label} must be refused, and named as ${diagnosis}`
      );
    });
  }
});

test('a probe that cannot reach the server degrades like an unreachable embedder', async () => {
  // The one probe failure that is an OUTAGE rather than a defect. `/v1/models`
  // shares an origin with the vectors, so a host that cannot answer it cannot
  // answer them either — and lib/corpus/search.js degrades to lexical retrieval
  // on `.unavailable` by name. Were this a hard error, an embedder outage would
  // turn a degraded search into a 500.
  await withFetch(routedFetch({ models: new Error('connect ECONNREFUSED') }), async () => {
    await assert.rejects(
      () => embed(['x']),
      (err) => err instanceof EmbedUnavailable && err.unavailable === true
    );
  });
});

test('a served dimension that disagrees with EMBED_DIM fails at first use', async () => {
  // The THIRD drift direction. The test below pins EMBED_DIM against the DDL in
  // both directions, but neither is checked against the LIVE SERVER, so an
  // embedder reconfigured to 768 behind a vector(1024) column was caught only by
  // Postgres at INSERT — after the chunk row was written, and reported against
  // the wrong layer.
  //
  // A RUNTIME guard, not an integration test. Integration tests in this repo
  // have never run (they are gated on DATABASE_URL and skip), so a check that
  // needs a live server to execute is worth nothing; this one runs in the
  // process that is about to write the vectors.
  await withFetch(routedFetch({ models: [{ id: 'bge-m3', meta: { n_embd: 768 } }] }), async () => {
    await assert.rejects(
      () => embed(['x']),
      (err) =>
        err.dimension === true &&
        !err.unavailable &&
        /768/.test(err.message) &&
        /1024/.test(err.message)
    );
  });
});

test('an absent n_embd degrades to not checking the dimension, rather than to failing', async () => {
  // llama.cpp reports `meta.n_embd` today, but the probe's contract is not owned
  // by this repo. An absent field must not take the embedder down: the guard is
  // an EXTRA check, and the per-vector shape check on the response still catches
  // a wrong dimension one step later. Failing closed here would turn a harmless
  // upstream field rename into a total outage of a working embedder.
  const { embedModel } = await withFetch(
    routedFetch({ models: [{ id: 'bge-m3', object: 'model' }] }),
    () => embed(['x'])
  );
  assert.equal(embedModel, 'bge_8005:bge-m3', 'the model is still identified; only the dimension check is skipped');
});

test('the model probe is cached per process, not repeated on every batch', async () => {
  const seen = [];
  await withFetch(routedFetch({ seen }), async () => {
    await embed(['a']);
    await embed(['b']);
    await embed(['c']);
  });
  const probes = seen.filter((s) => s.url.endsWith('/v1/models'));
  assert.equal(probes.length, 1, 'one probe for three batches');
  assert.equal(seen.filter((s) => s.url.endsWith('/v1/embeddings')).length, 3, 'and the vectors are not cached with it');
});

test('a failed probe is not cached, so a transient outage does not poison the process', async () => {
  // A cache that stored the rejection would make one refused connection
  // permanent for the lifetime of the process — the embedder would come back and
  // philotas would not.
  const realFetch = globalThis.fetch;
  _resetModelProbe();
  let attempt = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/v1/models') && attempt++ === 0) throw new Error('connect ECONNREFUSED');
    return routedFetch({})(url, init);
  };
  try {
    await assert.rejects(() => embed(['x']), (err) => err instanceof EmbedUnavailable);
    const { embedModel } = await embed(['x']);
    assert.equal(embedModel, 'bge_8005:bge-m3', 'the second attempt re-probes rather than replaying the failure');
    assert.equal(attempt, 2, 'the probe was actually retried');
  } finally {
    globalThis.fetch = realFetch;
    _resetModelProbe();
  }
});

test('EMBED_DIM agrees with the dimension the vector columns are declared at', () => {
  // Two independent statements of one number, and until now nothing asserted they
  // agreed. Measured 2026-08-17: EMBED_DIM 1024 → 768 does fail the suite, but
  // only through incidental literals elsewhere — a fixture length in
  // test/corpus-search.test.js and the `1024` inside the error-message regex
  // further down this file. The intentional assertions each pin their own side:
  // `vec()` above builds its fixtures FROM EMBED_DIM and the length assertion
  // below compares against EMBED_DIM, so both sides of that equality move
  // together, and test/schema-apply.test.js pins VECTOR(1024) with its own
  // separate literal. That is the RRF_K shape again.
  //
  // Why it earns a test rather than a tidier assertion: a client whose embedder
  // emits 768 or 1536 needs the column sized before anything is ingested, because
  // mixed dimensions in one vector column cannot be migrated, only regenerated. A
  // constant that has drifted from the DDL produces exactly that state, and
  // Postgres reports it at INSERT as a shape error attributed to the wrong layer.
  // The DDL text is the authority because it is what reaches the database.
  const ddl = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib', 'schema', 'semantic.sql'), 'utf8');
  const declared = [...ddl.matchAll(/VECTOR\((\d+)\)/gi)].map((match) => Number(match[1]));
  assert.ok(declared.length > 0, 'the DDL declares at least one vector column, or this test is reading the wrong file');
  for (const dimension of declared) {
    assert.equal(
      dimension,
      EMBED_DIM,
      `a vector column is declared at ${dimension} while lib/embed.js emits ${EMBED_DIM}`
    );
  }
  // The literal too, so moving the constant and the DDL together in one edit is
  // still a decision someone has to make rather than a change nothing notices.
  assert.equal(EMBED_DIM, 1024);
});

test('vectors come back in input order, with the serving service recorded', async () => {
  const embeddings = {
    model: 'bge-m3',
    // Deliberately out of order: the API returns an `index` and the client
    // must honour it rather than trusting array position.
    data: [
      { index: 1, embedding: vec(0.2) },
      { index: 0, embedding: vec(0.1) },
    ],
  };
  // The stub routes the probe separately from the vectors. It previously answered
  // every URL with this embeddings body, which meant the model probe read an
  // `id` off an embedding row — a stub loose enough that a broken probe passed.
  const { vectors, service } = await withFetch(routedFetch({ embeddings }), () =>
    embed(['first', 'second'])
  );
  assert.equal(service, 'bge_8005');
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0][0], 0.1, 'index 0 is the first input');
  assert.equal(vectors[1][0], 0.2);
  assert.equal(vectors[0].length, EMBED_DIM);
});

test('an empty input list costs no network call', async () => {
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return { ok: true, json: async () => ({ data: [] }) }; };
  try {
    const { vectors } = await embed([]);
    assert.deepEqual(vectors, []);
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a wrong-dimension vector is rejected rather than stored', async () => {
  // A 768-dimension vector in a vector(1024) column fails at INSERT with a
  // Postgres error that says nothing about which model produced it. Catch it
  // where the model is still known.
  // The probe is healthy and agrees with EMBED_DIM here, so what this isolates is
  // the per-vector shape check on the RESPONSE — a server that advertises 1024 and
  // then returns something else. The probe-level disagreement is its own test
  // below.
  await withFetch(
    routedFetch({ embeddings: { model: 'wrong-model', data: [{ index: 0, embedding: [1, 2, 3] }] } }),
    async () => {
      await assert.rejects(() => embed(['x']), /expected 1024 dimensions.*got 3/);
    }
  );
});

test('token counts come from the serving tokenizer', async () => {
  // Measured against the embedder's tokenizer on 2026-08-15, the sentence
  // "Container ship berths at Port Botany after a week-long delay."
  // tokenises to 18 tokens under bge-m3.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ tokens: new Array(18).fill(0) }),
  });
  try {
    assert.equal(await countTokens('Container ship berths at Port Botany after a week-long delay.'), 18);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unreachable embedder raises a named error', async () => {
  // Only the embeddings call fails; the probe answers. That isolates the vector
  // endpoint's own failure path from the probe's, which has its own test above —
  // with both down this would pass whichever of the two raised the error.
  await withFetch(routedFetch({ embeddings: new Error('connect ECONNREFUSED') }), async () => {
    await assert.rejects(() => embed(['x']), (err) => err instanceof EmbedUnavailable && err.unavailable === true);
  });
});

// ---------------------------------------------------------------------------
// A malformed embeddings payload the CLIENT refused, as classified by this file.
//
// @axoquant/llm 0.3.0 validates the embeddings response in its own readVectors()
// (node_modules/@axoquant/llm/js/client.js:445-486) and throws MalformedResponse,
// tagged `.malformed`, before any value reaches lib/embed.js. Up to 0.2.1 it did
// none of that. So everything arriving at the catch around embedTexts used to be
// transport, and is not any more.
//
// What these tests pin is the CLASSIFICATION. The degrade path is unchanged
// either way — both classes carry `.unavailable`, which is the tag
// lib/corpus/search.js:80 and lib/ontology/profiles.js:223 branch on — so the log
// line is the ONLY thing that tells an operator whether to go and look at a
// service, and a malformed response means the service is up and answering.
//
// The one-component-off body below is what a real drift looks like: a service
// that serves a JSON encoder emitting numbers as strings returns a full-length,
// full-count, correctly indexed embedding whose components are `"0.1"`. Postgres
// would coerce those into a VECTOR column without complaint.
const oneStringComponent = () => {
  const v = vec(0.1);
  v[3] = '0.5';
  return { model: 'bge-m3', data: [{ index: 0, embedding: v }] };
};

test('a malformed embeddings payload the client refused reads as malformed, not as an embedder outage', async () => {
  // KILLS: dropping the `err.malformed` re-throw from the catch around
  // embedTexts in lib/embed.js. The client refuses the component "0.5" itself,
  // so without the re-throw its MalformedResponse is flattened into
  // EmbedUnavailable and an operator is sent to check an embedder that is up.
  await withFetch(routedFetch({ embeddings: oneStringComponent() }), async () => {
    await assert.rejects(
      () => embed(['x']),
      (err) => {
        assert.equal(err.name, 'EmbedMalformed', 'its own class, not the outage class');
        assert.equal(err instanceof EmbedMalformed, true, 'and the class is exported, so callers can name it');
        assert.equal(err.unavailable, true, 'lib/corpus/search.js:80 degrades to lexical on this tag');
        assert.equal(err.malformed, true);
        assert.equal(err.reason, 'malformed-response', 'literal pinned, not imported from the module under test');
        // THIS file's own prefix, which is the assertion that does the work.
        // EmbedUnavailable wraps the identical client text with 'embedder
        // unavailable: ', so nothing below would tell the two apart on its own.
        assert.match(err.message, /^embedder malformed response: /, 'philotas says which of its own two states this is');
        // The client's detail, asserted for PRESERVATION rather than for
        // classification: an operator still needs to know which input came back
        // wrong and where, and re-wrapping must not discard it.
        assert.match(err.message, /input 0/, 'which input came back wrong survives the re-wrap');
        assert.match(err.message, /position 3/, 'and where in the vector');
        return true;
      },
    );
  });
});

test('every embeddings shape the client refuses is classified as malformed, across all four of its checks', async () => {
  // KILLS: the same missing re-throw, across the whole of readVectors() rather
  // than one branch of it. Each row is a DIFFERENT check in the client, so this
  // fails if the re-throw is written to match one message rather than the tag.
  const rows = [
    ['no `data` array', { model: 'bge-m3', object: 'list' }],
    ['an index outside the batch', { model: 'bge-m3', data: [{ index: 7, embedding: vec(0.1) }] }],
    ['an embedding that is not an array', { model: 'bge-m3', data: [{ index: 0, embedding: 'bge-m3' }] }],
    ['a non-finite component', { model: 'bge-m3', data: [{ index: 0, embedding: (() => { const v = vec(0.1); v[0] = null; return v; })() }] }],
    ['fewer embeddings than inputs', { model: 'bge-m3', data: [] }],
  ];
  for (const [label, embeddings] of rows) {
    await withFetch(routedFetch({ embeddings }), async () => {
      await assert.rejects(
        () => embed(['x']),
        (err) => {
          assert.equal(err.name, 'EmbedMalformed', `${label} must be refused as malformed`);
          assert.equal(err.reason, 'malformed-response', `${label} must not read as an outage`);
          assert.equal(err.malformed, true, `${label} must carry the tag callers switch on`);
          assert.equal(err.unavailable, true, `${label} must still degrade rather than 500`);
          return true;
        },
        `${label} must be refused`,
      );
    });
  }
});

test('a malformed embeddings payload is distinguishable from an outage, so nobody checks an embedder that is answering', async () => {
  // KILLS: reusing `new EmbedUnavailable(...)` for the malformed case, which
  // since @axoquant/llm 0.3.0 means dropping the `err.malformed` re-throw — the
  // client refuses first, so every malformed payload arrives at that catch and
  // nothing else distinguishes it. Both errors must keep `.unavailable === true`
  // so callers still degrade by name; collapsing them makes "the embedder
  // replied with nonsense" read as "the embedder is down" in the logs.
  //
  // Both legs go through the same routed `fetch` stub with a healthy probe, so
  // this compares two classifications of ONE layer's failures, not two layers.
  const capture = (stub) => withFetch(stub, () => embed(['x']).then(() => null, (e) => e));
  const outage = await capture(routedFetch({ embeddings: new Error('connect ECONNREFUSED') }));
  const malformed = await capture(routedFetch({ embeddings: oneStringComponent() }));

  assert.equal(outage.unavailable, true);
  assert.equal(malformed.unavailable, true);
  assert.equal(outage.name, 'EmbedUnavailable');
  assert.equal(malformed.name, 'EmbedMalformed');
  assert.equal(outage.reason, 'transport');
  assert.equal(malformed.reason, 'malformed-response');
  assert.equal(outage.malformed, undefined, 'an outage must not wear the contract-break tag');
  assert.equal(
    malformed instanceof EmbedUnavailable,
    false,
    'not a subtype of the outage, or an `instanceof` check misreports it as one',
  );
  // The two messages must not read alike either: this is what an operator sees.
  assert.match(outage.message, /^embedder unavailable: /);
  assert.match(malformed.message, /^embedder malformed response: /);
});

// Same reasoning as test/rerank.test.js: this file used to default to
// `http://localhost:8005`. `/tokenize` has no registry role of its own, so the
// risk is that its host gets written down separately and drifts from the
// embedder it is supposed to share a tokenizer with.
test('the vectors, the tokenizer and the model probe all resolve through the adapter', async () => {
  const { embedEndpoint } = await import('../lib/llm.js');
  const seen = [];
  await withFetch(routedFetch({ tokens: 3, seen }), async () => {
    await embed(['x']);
    await countTokens('x');
  });
  const urls = seen.map((s) => s.url);
  const origin = (await embedEndpoint()).origin;
  // The probe is the THIRD endpoint this file talks to and the newest chance to
  // write a host down twice. `/v1/models` has no adapter role of its own, so like
  // `/tokenize` its origin is derived from the embed role rather than repeated.
  assert.deepEqual(
    urls,
    [`${origin}/v1/models`, `${origin}/v1/embeddings`, `${origin}/tokenize`],
    'the probe precedes the vectors, and all three share the adapter-resolved origin'
  );
  assert.ok(!urls.some((u) => /localhost/.test(u)), 'localhost is never the right answer off a configured host');
});

test('every call is attributed, so chunking cost is separable from query cost', async () => {
  const seen = [];
  await withFetch(routedFetch({ seen }), async () => {
    await embed(['x'], { app: 'philotas/corpus' });
    await countTokens('x', { app: 'philotas/corpus' });
  });
  // Three calls now, and the probe is one of them. An unattributed probe would
  // show up in the embedder's own accounting as traffic from nobody.
  assert.deepEqual(
    seen.map((s) => s.init?.headers?.['X-Algolotl-App']),
    ['philotas/corpus', 'philotas/corpus', 'philotas/corpus']
  );
});
