// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createClient } from '../src/client.mjs';
import { TOOLS, createHandlers } from '../src/tools.mjs';
import { startStubApi } from './stub-api.mjs';

function parse(res) {
  return JSON.parse(res.content[0].text);
}

async function handlersFor(api, extra = {}) {
  const client = createClient({ baseUrl: api.url });
  return createHandlers({ client, ...extra });
}

test('tool list declares all ten tools', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'philotas_alerts',
    'philotas_detections',
    'philotas_feed',
    'philotas_graph',
    'philotas_regions',
    'philotas_search',
    'philotas_status',
    'run_tests',
    'scaffold_connector',
    'validate_connector',
  ].sort());
});

test('philotas_status maps the /api/status payload', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_status({});
    const data = parse(res);
    assert.equal(data.region, 'sydney');
    assert.equal(data.feeds.aviation.count, 4);
  } finally {
    await api.close();
  }
});

test('philotas_regions maps the /api/regions payload', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_regions({});
    const data = parse(res);
    assert.equal(data.regions.length, 2);
    assert.equal(data.regions[1].id, 'world');
  } finally {
    await api.close();
  }
});

test('philotas_feed maps /api/feeds/{feed} and forwards region', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_feed({ feed: 'aviation', region: 'sydney' });
    const data = parse(res);
    assert.equal(data.feed, 'aviation');
    assert.equal(data.region, 'sydney');
    assert.equal(data.type, 'FeatureCollection');
  } finally {
    await api.close();
  }
});

test('philotas_feed requires a feed argument', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_feed({});
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes('feed'));
  } finally {
    await api.close();
  }
});

test('philotas_graph maps the /api/graph payload', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_graph({ region: 'sydney' });
    const data = parse(res);
    assert.equal(data.nodes[0].id, 'n1');
    assert.equal(data.method, 'heuristic');
  } finally {
    await api.close();
  }
});

test('philotas_search maps query to q and forwards region', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_search({ query: 'ship', region: 'sydney' });
    const data = parse(res);
    assert.equal(data.q, 'ship');
    assert.equal(data.region, 'sydney');
  } finally {
    await api.close();
  }
});

test('philotas_search requires a query argument', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_search({});
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes('query'));
  } finally {
    await api.close();
  }
});

test('philotas_alerts maps the /api/alerts payload', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_alerts({ region: 'sydney' });
    const data = parse(res);
    assert.equal(data.count, 0);
    assert.equal(data.region, 'sydney');
  } finally {
    await api.close();
  }
});

test('philotas_detections maps the /api/detections payload', async () => {
  const api = await startStubApi();
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_detections({ region: 'sydney' });
    const data = parse(res);
    assert.equal(data.count, 0);
  } finally {
    await api.close();
  }
});

test('degrades gracefully with a clear message when the API errors', async () => {
  const api = await startStubApi({ statusCode: 500 });
  try {
    const h = await handlersFor(api);
    const res = await h.philotas_status({});
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes('500'));
  } finally {
    await api.close();
  }
});

test('scaffold_connector writes an api template matching the defineConnector shape', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-mcp-'));
  try {
    const h = createHandlers({ cwd: dir });
    const res = await h.scaffold_connector({ name: 'my-feed', kind: 'api', endpoint: 'https://example.com/feed.json' });
    assert.ok(!res.isError);
    const data = parse(res);
    assert.equal(data.name, 'my-feed');
    assert.equal(data.kind, 'api');
    const filePath = path.join(dir, 'connectors', 'my-feed.js');
    assert.ok(fs.existsSync(filePath));
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('defineConnector'));
    assert.ok(content.includes('apiPull'));
    assert.ok(content.includes("kind: 'api'"));
    assert.ok(content.includes('pull:'));
    assert.ok(content.includes("id: 'my-feed'"));
    assert.ok(content.includes('https://example.com/feed.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold_connector writes a datalake template', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-mcp-'));
  try {
    const h = createHandlers({ cwd: dir });
    const res = await h.scaffold_connector({ name: 'my-lake', kind: 'datalake' });
    assert.ok(!res.isError);
    const filePath = path.join(dir, 'connectors', 'my-lake.js');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('datalakePull'));
    assert.ok(content.includes("kind: 'datalake'"));
    assert.ok(content.includes('query:'));
    assert.ok(content.includes('toFeature:'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scaffold_connector rejects an invalid kind', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-mcp-'));
  try {
    const h = createHandlers({ cwd: dir });
    const res = await h.scaffold_connector({ name: 'x', kind: 'nope' });
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes('kind'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate_connector passes for a valid fixture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-mcp-'));
  try {
    const file = path.join(dir, 'valid.mjs');
    fs.writeFileSync(file, "export const validConnector = { id: 'valid', kind: 'api', pull: async () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [151, -33] }, properties: { title: 'x' } }] }) };");
    const h = createHandlers({ cwd: dir });
    const res = await h.validate_connector({ path: file });
    const data = parse(res);
    assert.equal(data.valid, true);
    assert.equal(data.features, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate_connector fails with a reason for an invalid fixture', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-mcp-'));
  try {
    const file = path.join(dir, 'invalid.mjs');
    fs.writeFileSync(file, "export const invalidConnector = { id: 'invalid', kind: 'api', pull: async () => ({ not: 'geojson' }) };");
    const h = createHandlers({ cwd: dir });
    const res = await h.validate_connector({ path: file });
    const data = parse(res);
    assert.equal(data.valid, false);
    assert.ok(data.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate_connector fails with the thrown reason when pull() throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'philotas-mcp-'));
  try {
    const file = path.join(dir, 'throwing.mjs');
    fs.writeFileSync(file, "export const bad = { id: 'bad', kind: 'api', pull: async () => { throw new Error('boom'); } };");
    const h = createHandlers({ cwd: dir });
    const res = await h.validate_connector({ path: file });
    const data = parse(res);
    assert.equal(data.valid, false);
    assert.ok(data.reason.includes('boom'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate_connector requires a path argument', async () => {
  const h = createHandlers({ cwd: os.tmpdir() });
  const res = await h.validate_connector({});
  assert.equal(res.isError, true);
  assert.ok(res.content[0].text.includes('path'));
});

test('run_tests spawns node --test and parses pass/fail counts', async () => {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', 'ok 1 - a');
      child.stdout.emit('data', '# tests 3');
      child.stdout.emit('data', '# pass 2');
      child.stdout.emit('data', '# fail 1');
      child.emit('close', 1);
    });
    return child;
  };
  const h = createHandlers({ cwd: '/fake/project', spawnImpl });
  const res = await h.run_tests({});
  const data = parse(res);
  assert.equal(data.pass, 2);
  assert.equal(data.fail, 1);
  assert.equal(data.total, 3);
  assert.equal(data.ok, false);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, process.execPath);
  assert.deepEqual(spawned[0].args, ['--test', '--test-reporter=tap']);
  assert.equal(spawned[0].opts.cwd, '/fake/project');
});
