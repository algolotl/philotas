// SPDX-License-Identifier: Apache-2.0
// test/llm-adapter.test.js
//
// lib/llm.js against a local node:http stub. Exercises the HTTP provider (chat,
// embeddings, the rerank 404 -> chat-based fallback), the heuristic provider
// when nothing is configured and the optional @axoquant/llm dependency cannot
// be imported, and the MalformedResponse contract for a non-JSON body.
//
// The heuristic path needs import('@axoquant/llm') to FAIL, which it would not
// on a normal checkout (the package is an optionalDependency and is installed
// here). A node:module resolve hook throws for that specifier for the whole of
// this process; every test that wants the HTTP provider sets PHILOTAS_LLM_URL,
// which the adapter checks before it ever tries the import.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { register } from 'node:module';

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === '@axoquant/llm') {
      throw new Error('test/llm-adapter.test.js: @axoquant/llm is unavailable in this process');
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { chat, embed, rerank, resolveProvider, MalformedResponse } = await import('../lib/llm.js');

// ---------------------------------------------------------------- helpers

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function withServer(handler) {
  const server = http.createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end('handler error'); }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// ---------------------------------------------------------------- HTTP chat

test('chat POSTs to /v1/chat/completions and returns text, finish reason and tokens', async () => {
  let seen = null;
  const { base, close } = await withServer(async (req, res) => {
    seen = { method: req.method, url: req.url, body: JSON.parse(await readBody(req)) };
    json(res, 200, {
      choices: [{ message: { content: 'all clear' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
  });

  await withEnv({ PHILOTAS_LLM_URL: base, OPENAI_COMPATIBLE_ENDPOINT: undefined }, async () => {
    const r = await chat('assistant', [{ role: 'user', content: 'report' }], {
      app: 'philotas/test', maxTokens: 128, temperature: 0,
    });
    assert.equal(r.text, 'all clear');
    assert.equal(r.provider, 'http');
    assert.equal(r.finishReason, 'stop');
    assert.equal(r.totalTokens, 10);
  });

  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v1/chat/completions');
  assert.deepEqual(seen.body.messages, [{ role: 'user', content: 'report' }]);
  assert.equal(seen.body.max_tokens, 128);
  await close();
});

test('OPENAI_COMPATIBLE_ENDPOINT is honoured exactly like PHILOTAS_LLM_URL', async () => {
  let seen = null;
  const { base, close } = await withServer(async (req, res) => {
    seen = { url: req.url };
    json(res, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });

  await withEnv({ PHILOTAS_LLM_URL: undefined, OPENAI_COMPATIBLE_ENDPOINT: base }, async () => {
    const r = await chat('assistant', [{ role: 'user', content: 'hi' }], { app: 'philotas/test' });
    assert.equal(r.provider, 'http');
    assert.equal(r.text, 'ok');
  });
  assert.equal(seen.url, '/v1/chat/completions');
  await close();
});

// ---------------------------------------------------------------- HTTP embed

test('embed POSTs to /v1/embeddings and returns vectors in input order', async () => {
  let seen = null;
  const { base, close } = await withServer(async (req, res) => {
    seen = { url: req.url, body: JSON.parse(await readBody(req)) };
    json(res, 200, {
      model: 'some-embedder',
      // Deliberately out of input order: the adapter must honour the index.
      data: [
        { index: 1, embedding: [0, 0, 1] },
        { index: 0, embedding: [1, 0, 0] },
      ],
    });
  });

  await withEnv({ PHILOTAS_LLM_URL: base }, async () => {
    const { vectors, provider } = await embed(['a', 'b'], { app: 'philotas/test' });
    assert.equal(provider, 'http');
    assert.deepEqual(vectors, [[1, 0, 0], [0, 0, 1]]);
  });

  assert.equal(seen.url, '/v1/embeddings');
  assert.deepEqual(seen.body.input, ['a', 'b']);
  await close();
});

// ------------------------------------------- HTTP rerank with chat fallback

test('rerank falls back to a chat-based rerank when /v1/rerank answers 404', async () => {
  const seen = [];
  const { base, close } = await withServer(async (req, res) => {
    seen.push(req.url);
    if (req.url === '/v1/rerank') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (req.url === '/v1/chat/completions') {
      json(res, 200, { choices: [{ message: { content: '[0.2, 0.9, 0.4]' } }] });
      return;
    }
    res.writeHead(500); res.end('unexpected');
  });

  await withEnv({ PHILOTAS_LLM_URL: base }, async () => {
    const { scores, provider } = await rerank('q', ['a', 'b', 'c'], { app: 'philotas/test' });
    assert.equal(provider, 'http');
    assert.deepEqual(scores, [0.2, 0.9, 0.4]);
  });

  assert.deepEqual(seen, ['/v1/rerank', '/v1/chat/completions'], 'rerank was tried first, then chat');
  await close();
});

test('a native /v1/rerank response is parsed without any chat call', async () => {
  const seen = [];
  const { base, close } = await withServer(async (req, res) => {
    seen.push(req.url);
    if (req.url === '/v1/rerank') {
      json(res, 200, {
        results: [
          { index: 1, relevance_score: -2.0 },
          { index: 0, relevance_score: 1.5 },
        ],
      });
      return;
    }
    res.writeHead(500); res.end('unexpected');
  });

  await withEnv({ PHILOTAS_LLM_URL: base }, async () => {
    const { scores, provider } = await rerank('q', ['a', 'b'], { app: 'philotas/test' });
    assert.equal(provider, 'http');
    assert.deepEqual(scores, [1.5, -2.0], 'input order, not service order');
  });
  assert.deepEqual(seen, ['/v1/rerank']);
  await close();
});

// ---------------------------------------------------------------- heuristic

test('resolveProvider reports http for either env var, and heuristic when nothing is importable', async () => {
  assert.equal(await resolveProvider({ PHILOTAS_LLM_URL: 'http://example.test' }), 'http');
  assert.equal(await resolveProvider({ OPENAI_COMPATIBLE_ENDPOINT: 'http://example.test' }), 'http');
  assert.equal(await resolveProvider({}), 'heuristic');
});

test('with nothing configured, chat, embed and rerank all fail with a clear error', async () => {
  await withEnv({ PHILOTAS_LLM_URL: undefined, OPENAI_COMPATIBLE_ENDPOINT: undefined }, async () => {
    await assert.rejects(
      () => chat('assistant', [{ role: 'user', content: 'hi' }], { app: 'philotas/test' }),
      /configured/,
    );
    await assert.rejects(
      () => embed(['a'], { app: 'philotas/test' }),
      /configured/,
    );
    await assert.rejects(
      () => rerank('q', ['a'], { app: 'philotas/test' }),
      /configured/,
    );
  });
});

// ---------------------------------------------------------------- malformed

test('a non-JSON chat body raises MalformedResponse', async () => {
  const { base, close } = await withServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('this is not json');
  });

  await withEnv({ PHILOTAS_LLM_URL: base }, async () => {
    await assert.rejects(
      () => chat('assistant', [{ role: 'user', content: 'hi' }], { app: 'philotas/test' }),
      (err) => err instanceof MalformedResponse && err.name === 'MalformedResponse' && err.malformed === true,
    );
  });
  await close();
});

test('a well-formed embed body that lacks the data array raises MalformedResponse', async () => {
  const { base, close } = await withServer(async (req, res) => {
    json(res, 200, { object: 'list' });
  });

  await withEnv({ PHILOTAS_LLM_URL: base }, async () => {
    await assert.rejects(
      () => embed(['a'], { app: 'philotas/test' }),
      (err) => err instanceof MalformedResponse && err.name === 'MalformedResponse' && err.malformed === true,
    );
  });
  await close();
});

test('a non-2xx HTTP response is a transport error, not a malformed one', async () => {
  const { base, close } = await withServer(async (req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('no backend available');
  });

  await withEnv({ PHILOTAS_LLM_URL: base }, async () => {
    await assert.rejects(
      () => chat('assistant', [{ role: 'user', content: 'hi' }], { app: 'philotas/test' }),
      (err) => err.malformed === undefined && /503/.test(err.message),
    );
  });
  await close();
});
