import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// lib/ontology/build.js reaches sample-lake JSON through the feed modules,
// which import it without an import attribute. Same loader shim as
// test/vessels.test.js.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

// The HTTP provider, named explicitly. Without this the adapter falls through to
// the optional @axoquant/llm package, which is private and is NOT part of this
// tree — so the file only passed on a checkout that happened to have it
// installed, and it was exercising that package rather than the adapter.
// `bge_8005` is the service identity the adapter composes from the host; every
// stub in this file routes by path suffix, so no port is involved and nothing binds.
process.env.PHILOTAS_LLM_URL = 'http://bge_8005';
// The ontology artifact is what tells an operator how a link was decided. It
// must report how many candidates fell in the uncertainty band and whether
// scoring was degraded: a band that swallows most candidates means the
// thresholds are wrong, and that has to be visible rather than silent.
//
// lib/ontology/build.js exports `buildOntology(feeds)` — a single argument
// mapping feed key -> feature collection (see lib/ontology/service.js, the
// route's only caller, which spreads the returned artifact straight into
// Response.json with no field renaming). An empty feeds object is the one
// input that needs no network and no database: induce() finds no feeds to
// map, resolve() finds no entities to generate candidates from, and
// scoreCandidates() is never called.
test('the artifact reports the scoring counters and never claims the LLM', async () => {
  const { buildOntology } = await import('../lib/ontology/build.js');
  const artifact = await buildOntology({});

  assert.equal(artifact.usedLlm, false, 'no generative model in the link path');
  assert.notEqual(artifact.method, 'llm');
  assert.equal(typeof artifact.candidatesAdjudicated, 'number');
  assert.equal(typeof artifact.candidatesBanded, 'number', 'band width is reported');
  assert.ok('scoringDegraded' in artifact, 'degradation is reported even when null');
});

// The test above passes even if candidatesBanded/scoringDegraded were
// hardcoded to 0/null, because an empty feed set never generates a candidate
// in the first place — it never exercises the wiring between
// scoreCandidates()'s output and the artifact. This test forces one real
// candidate through the whole pipeline (induce -> resolve -> scoreCandidates)
// with a stubbed reranker score placed deliberately inside the band, and
// checks that the artifact's counters reflect that real outcome: banded=1,
// no link emitted for the banded candidate, and no degradation reported
// (the reranker "responded", it just didn't decide). If build.js stopped
// threading scoreCandidates()'s `banded`/`degraded` through to the returned
// artifact, this would fail.
test('a candidate that lands in the band is counted and produces no link', async () => {
  const { buildOntology } = await import('../lib/ontology/build.js');

  const feeds = {
    aviation: {
      features: [{
        properties: { callsign: 'QFA123' },
        geometry: { coordinates: [151.2, -33.8] },
      }],
    },
    news: {
      features: [{
        properties: { title: 'QFA123 diverts after mechanical issue' },
        geometry: null,
      }],
    },
  };

  const realFetch = globalThis.fetch;
  // logit 0.0 -> sigmoid 0.5, strictly between REJECT_THRESHOLD (0.20) and
  // ACCEPT_THRESHOLD (0.80): a deliberate band hit, not an accept or reject.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ results: [{ index: 0, relevance_score: 0.0 }] }),
  });

  let artifact;
  try {
    artifact = await buildOntology(feeds);
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(artifact.candidatesAdjudicated, 1, 'the callsign-in-headline candidate was generated');
  assert.equal(artifact.candidatesBanded, 1, 'the mid-range score is counted as banded, not decided');
  assert.equal(artifact.scoringDegraded, null, 'the reranker answered; it just landed in the band');
  assert.equal(artifact.method, 'cross-encoder');
  assert.ok(
    !artifact.links.some((l) => l.type === 'mentions'),
    'a banded candidate must not be asserted as a link'
  );
});
