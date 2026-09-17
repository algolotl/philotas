// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStubApi } from './stub-api.mjs';
import { createClient, PhilotasHttpError } from '../src/client.mjs';

test('client logs in once and attaches the session cookie', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const client = createClient({ baseUrl: api.url, username: 'test', password: 'secret' });
    const status = await client.get('/api/status');
    assert.equal(status.region, 'sydney');
  } finally {
    await api.close();
  }
});

test('client token mode attaches the cookie without logging in', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const client = createClient({ baseUrl: api.url, token: 'stub-session' });
    const status = await client.get('/api/status');
    assert.equal(status.region, 'sydney');
  } finally {
    await api.close();
  }
});

test('client login failure surfaces the 401', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const client = createClient({ baseUrl: api.url, username: 'test', password: 'wrong' });
    await assert.rejects(() => client.get('/api/status'), (err) => err instanceof PhilotasHttpError && err.status === 401);
  } finally {
    await api.close();
  }
});

test('client without credentials surfaces the guarded 401', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const client = createClient({ baseUrl: api.url });
    await assert.rejects(() => client.get('/api/status'), (err) => err instanceof PhilotasHttpError && err.status === 401);
  } finally {
    await api.close();
  }
});


test('client guest bootstrap works against a trial-style deployment', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const client = createClient({ baseUrl: api.url, guest: true });
    const status = await client.get('/api/status');
    assert.equal(status.region, 'sydney');
  } finally {
    await api.close();
  }
});

