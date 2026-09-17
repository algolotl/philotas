// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubApi } from './stub-api.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'philotas-mcp.mjs');

function runDoctor(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'doctor'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('doctor exits 0 and prints PASS when the URL is healthy', async () => {
  const api = await startStubApi();
  try {
    const res = await runDoctor({ PHILOTAS_URL: api.url });
    assert.equal(res.code, 0);
    assert.ok(res.out.includes('PASS PHILOTAS_URL'));
    assert.ok(res.out.includes('PASS GET /api/status'));
  } finally {
    await api.close();
  }
});

test('doctor exits 1 when PHILOTAS_URL is unset', async () => {
  const res = await runDoctor({ PHILOTAS_URL: '' });
  assert.equal(res.code, 1);
  assert.ok(res.out.includes('FAIL PHILOTAS_URL'));
});

test('doctor exits 1 when /api/status returns non-200', async () => {
  const api = await startStubApi({ statusCode: 500 });
  try {
    const res = await runDoctor({ PHILOTAS_URL: api.url });
    assert.equal(res.code, 1);
    assert.ok(res.out.includes('PASS PHILOTAS_URL'));
    assert.ok(res.out.includes('FAIL GET /api/status'));
  } finally {
    await api.close();
  }
});


test('doctor passes against a guarded deployment when credentials are provided', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const res = await runDoctor({ PHILOTAS_URL: api.url, PHILOTAS_USER: 'test', PHILOTAS_PASSWORD: 'secret' });
    assert.equal(res.code, 0);
    assert.ok(res.out.includes('PASS GET /api/status'));
  } finally {
    await api.close();
  }
});

test('doctor fails with an actionable hint when auth is required but missing', async () => {
  const api = await startStubApi({ requireAuth: true });
  try {
    const res = await runDoctor({ PHILOTAS_URL: api.url });
    assert.equal(res.code, 1);
    assert.ok(res.out.includes('FAIL GET /api/status'));
    assert.ok(res.out.includes('PHILOTAS_USER'));
  } finally {
    await api.close();
  }
});

