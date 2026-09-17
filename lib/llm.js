// SPDX-License-Identifier: Apache-2.0
// lib/llm.js
//
// One provider adapter for the three model calls Philotas makes: chat
// (generation), embed (vectors) and rerank (cross-encoder scores).
//
// Providers resolve in a fixed order:
//
//   1. HTTP — when PHILOTAS_LLM_URL or OPENAI_COMPATIBLE_ENDPOINT is set, the
//      adapter talks to an OpenAI-compatible base URL: /v1/chat/completions,
//      /v1/embeddings, and /v1/rerank (falling back to a chat-based rerank when
//      that endpoint answers 404, because /v1/rerank is not part of the OpenAI
//      surface). The model name, when the endpoint needs one, comes from
//      PHILOTAS_LLM_MODEL or opts.model; it is omitted when neither is set.
//   2. @axoquant/llm — the internal registry client, imported dynamically so it
//      is an optional dependency rather than a hard one. When it is installed it
//      is used unchanged, which keeps every existing guard and validation.
//   3. heuristic — deterministic fallback. There is no generative heuristic:
//      chat, embed and rerank all throw, and each caller degrades to its own
//      deterministic behaviour (template summaries, lexical retrieval).
//
// Errors are shaped to match what the call sites already catch. A malformed
// response is a MalformedResponse carrying `.malformed === true` — the same tag
// the @axoquant/llm client raises — so lib/embed.js and lib/rerank.js classify
// it as EmbedMalformed / RerankMalformed. A non-2xx or a transport failure is a
// plain Error, which those wrappers classify as unavailable.
//
// No new dependencies: this uses the global fetch built into Node 22.

export class MalformedResponse extends Error {
  constructor(message) {
    super(message);
    this.name = 'MalformedResponse';
    this.malformed = true;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

// The OpenAI-compatible base URL, or null when HTTP is not configured.
function baseUrl(env = process.env) {
  const raw = env?.PHILOTAS_LLM_URL || env?.OPENAI_COMPATIBLE_ENDPOINT;
  if (!raw) return null;
  return String(raw).trim().replace(/\/+$/, '');
}

// The optional dependency, loaded once and cached. A failed load caches the
// failure so an absent package does not become a re-import per call.
let axoquantPromise;

function loadAxaquant() {
  if (axoquantPromise === undefined) {
    axoquantPromise = import('@axoquant/llm').catch((err) => {
      axoquantPromise = null;
      throw err;
    });
  }
  if (axoquantPromise === null) {
    return Promise.reject(new Error('@axoquant/llm is not installed'));
  }
  return axoquantPromise;
}

export async function resolveProvider(env = process.env) {
  if (baseUrl(env)) return 'http';
  try {
    await loadAxaquant();
    return 'axoquant';
  } catch {
    return 'heuristic';
  }
}

function noProvider(kind) {
  return new Error(
    `no ${kind} provider is configured (set PHILOTAS_LLM_URL or OPENAI_COMPATIBLE_ENDPOINT, or install the optional @axoquant/llm dependency)`
  );
}

// A value in an error message, with strings quoted so "0.5" cannot read as 0.5.
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

async function postJson(url, body, { app, timeoutMs }) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(app ? { 'X-Algolotl-App': app } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

async function readJson(res, what) {
  try {
    return await res.json();
  } catch {
    throw new MalformedResponse(`${what}: the response body was not valid JSON`);
  }
}

function httpModel(env, opts) {
  return opts?.model || env?.PHILOTAS_LLM_MODEL || null;
}

// ------------------------------------------------------------------- HTTP chat

async function chatHttp(role, messages, opts, env) {
  const base = baseUrl(env);
  const body = { messages };
  const model = httpModel(env, opts);
  if (model) body.model = model;
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (opts.extra) Object.assign(body, opts.extra);

  const url = `${base}/v1/chat/completions`;
  const res = await postJson(url, body, opts);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`${url} returned ${res.status}: ${detail}`);
  }
  const data = await readJson(res, 'chat');
  const choice = data?.choices?.[0];
  if (!choice || typeof choice.message?.content !== 'string') {
    throw new MalformedResponse('chat: the response carried no `choices[0].message.content` string');
  }
  const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined;
  const usage = data.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  return {
    text: choice.message.content,
    finishReason,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    redactions: 0,
    endpoint: 'http',
    raw: data,
    provider: 'http',
  };
}

// ------------------------------------------------------------------ HTTP embed

// The index-validation and shape checks the @axoquant/llm client applies, kept
// here so the HTTP provider enforces the same contract a caller can rely on.
function claimIndex(what, index, count, claimed, noun) {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new MalformedResponse(
      `${what}: the service named index ${show(index)} for a batch of ${count} ${noun}, so the answer cannot be attributed to an input`
    );
  }
  if (claimed[index]) {
    throw new MalformedResponse(
      `${what}: the service named index ${index} twice, so one of the ${count} ${noun} was answered for and another was not`
    );
  }
  claimed[index] = true;
  return index;
}

function readVectors(data, count) {
  const rows = data?.data;
  if (!Array.isArray(rows)) {
    throw new MalformedResponse('embed: the response carried no `data` array (found ' + show(rows) + ')');
  }
  const vectors = new Array(count);
  const claimed = new Array(count).fill(false);
  for (let n = 0; n < rows.length; n++) {
    const row = rows[n];
    const index = claimIndex('embed', row?.index, count, claimed, 'inputs');
    const embedding = row?.embedding;
    if (!Array.isArray(embedding)) {
      throw new MalformedResponse(`embed: the embedding for input ${index} is not an array (found ${show(embedding)})`);
    }
    // An indexed loop, not .every() or .forEach(): those SKIP holes, and a hole
    // reads as undefined, which is the value that must be rejected.
    for (let position = 0; position < embedding.length; position++) {
      const component = embedding[position];
      if (!Number.isFinite(component)) {
        throw new MalformedResponse(
          `embed: the embedding for input ${index} has a non-finite component at position ${position}: ${show(component)} (${typeof component})`
        );
      }
    }
    vectors[index] = embedding;
  }
  if (rows.length !== count) {
    throw new MalformedResponse(
      `embed: the service returned ${rows.length} embedding${rows.length === 1 ? '' : 's'} for ${count} inputs, so at least one input would be given no vector`
    );
  }
  return vectors;
}

async function embedHttp(texts, opts, env) {
  const base = baseUrl(env);
  const body = { input: texts };
  const model = httpModel(env, opts);
  if (model) body.model = model;

  const url = `${base}/v1/embeddings`;
  const res = await postJson(url, body, opts);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`${url} returned ${res.status}: ${detail}`);
  }
  const data = await readJson(res, 'embed');
  return { vectors: readVectors(data, texts.length), model: data?.model ?? null, provider: 'http' };
}

// ------------------------------------------------------------------ HTTP rerank

function readScores(data, count) {
  const results = data?.results;
  if (!Array.isArray(results)) {
    throw new MalformedResponse('rerank: the response carried no `results` array (found ' + show(results) + ')');
  }
  const scores = new Array(count);
  const claimed = new Array(count).fill(false);
  for (let n = 0; n < results.length; n++) {
    const item = results[n];
    const index = claimIndex('rerank', item?.index, count, claimed, 'documents');
    const score = item?.relevance_score;
    if (!Number.isFinite(score)) {
      throw new MalformedResponse(
        `rerank: index ${index} scored ${show(score)} (${typeof score}), which is not a finite number`
      );
    }
    scores[index] = score;
  }
  if (results.length !== count) {
    throw new MalformedResponse(
      `rerank: the service scored ${results.length} of ${count} documents`
    );
  }
  return scores;
}

function parseScores(text, count) {
  let arr = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) arr = parsed;
    else if (Array.isArray(parsed?.scores)) arr = parsed.scores;
  } catch { /* try bracket extraction */ }
  if (!arr) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { arr = JSON.parse(text.slice(start, end + 1)); } catch { arr = null; }
    }
  }
  if (!Array.isArray(arr) || arr.length !== count) {
    throw new MalformedResponse(`rerank: the chat fallback did not return ${count} scores (found ${show(arr)})`);
  }
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new MalformedResponse(`rerank: the chat fallback returned a non-finite score at index ${i}: ${show(arr[i])}`);
    }
  }
  return arr;
}

async function rerankViaChat(query, documents, opts, env) {
  const base = baseUrl(env);
  const messages = [
    {
      role: 'system',
      content:
        'You rank documents by relevance to a query. Return ONLY a JSON array of numbers, one per document in the order given, where a higher number means more relevant.',
    },
    {
      role: 'user',
      content: `Query: ${query}\n\nDocuments:\n${documents.map((d, i) => `${i}: ${d}`).join('\n')}\n\nReturn a JSON array of ${documents.length} scores.`,
    },
  ];
  const body = { messages, max_tokens: 512, temperature: 0 };
  const model = httpModel(env, opts);
  if (model) body.model = model;
  if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
  body.response_format = { type: 'json_object' };

  const url = `${base}/v1/chat/completions`;
  const res = await postJson(url, body, opts);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`${url} returned ${res.status}: ${detail}`);
  }
  const data = await readJson(res, 'rerank (chat fallback)');
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new MalformedResponse('rerank: the chat fallback returned no content string');
  }
  return { scores: parseScores(text, documents.length), provider: 'http' };
}

async function rerankHttp(query, documents, opts, env) {
  const base = baseUrl(env);
  const body = { query, documents };
  const model = httpModel(env, opts);
  if (model) body.model = model;

  const url = `${base}/v1/rerank`;
  const res = await postJson(url, body, opts);
  if (res.status === 404) {
    return rerankViaChat(query, documents, opts, env);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`${url} returned ${res.status}: ${detail}`);
  }
  const data = await readJson(res, 'rerank');
  return { scores: readScores(data, documents.length), provider: 'http' };
}

// ------------------------------------------------------------- entry points

export async function chat(role, messages, opts = {}) {
  const env = opts.env || process.env;
  const provider = await resolveProvider(env);
  if (provider === 'http') return chatHttp(role, messages, opts, env);
  if (provider === 'axoquant') {
    const m = await loadAxaquant();
    const r = await m.chat(role, messages, opts);
    return { ...r, finishReason: r.raw?.choices?.[0]?.finish_reason, provider: 'axoquant' };
  }
  throw noProvider('LLM');
}

export async function embed(texts, opts = {}) {
  const env = opts.env || process.env;
  const provider = await resolveProvider(env);
  if (provider === 'http') return embedHttp(texts, opts, env);
  if (provider === 'axoquant') {
    const m = await loadAxaquant();
    return { vectors: await m.embed(texts, opts), provider: 'axoquant' };
  }
  throw noProvider('embedding');
}

export async function rerank(query, documents, opts = {}) {
  const env = opts.env || process.env;
  const provider = await resolveProvider(env);
  if (provider === 'http') return rerankHttp(query, documents, opts, env);
  if (provider === 'axoquant') {
    const m = await loadAxaquant();
    return { scores: await m.rerank(query, documents, opts), provider: 'axoquant' };
  }
  throw noProvider('reranking');
}

// The embed service identity and origin, used by lib/embed.js to compose the
// embed_model identity and to derive the /v1/models probe and /tokenize URLs.
export async function embedEndpoint(env = process.env) {
  const provider = await resolveProvider(env);
  if (provider === 'http') {
    const u = new URL(baseUrl(env));
    return { service: u.host, origin: u.origin, provider };
  }
  if (provider === 'axoquant') {
    const m = await loadAxaquant();
    const ep = m.get('embed');
    return { service: ep.service, origin: new URL(ep.url).origin, provider };
  }
  throw noProvider('embedding');
}
