// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, PhilotasApiError, PhilotasHttpError, PhilotasTimeoutError } from '../src/client.mjs';
import { startStubApi } from './stub-api.mjs';

test('get() builds the URL and returns parsed JSON', async () => {
  const api = await startStubApi();
  try {
    const client = createClient({ baseUrl: api.url });
    const data = await client.get('/api/regions');
    assert.equal(data.regions.length, 2);
    assert.equal(data.regions[0].id, 'sydney');
  } finally {
    await api.close();
  }
});

test('get() forwards query params and drops empty ones', async () => {
  const api = await startStubApi();
  try {
    const client = createClient({ baseUrl: api.url });
    const data = await client.get('/api/search', { params: { q: 'ship', region: 'sydney', empty: '' } });
    assert.equal(data.q, 'ship');
    assert.equal(data.region, 'sydney');
  } finally {
    await api.close();
  }
});

test('throws PhilotasHttpError with status on non-2xx', async () => {
  const api = await startStubApi();
  try {
    const client = createClient({ baseUrl: api.url });
    await assert.rejects(
      () => client.get('/api/does-not-exist'),
      (e) => e instanceof PhilotasHttpError && e.status === 404,
    );
  } finally {
    await api.close();
  }
});

test('throws PhilotasApiError when base URL is missing', async () => {
  const client = createClient({ baseUrl: '' });
  await assert.rejects(
    () => client.get('/api/status'),
    (e) => e instanceof PhilotasApiError && e.message.includes('PHILOTAS_URL'),
  );
});

test('times out after the configured duration', async () => {
  const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const client = createClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 20, fetchImpl });
  await assert.rejects(
    () => client.get('/api/status'),
    (e) => e instanceof PhilotasTimeoutError,
  );
});
