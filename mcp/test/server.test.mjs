// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';

let sdkAvailable = true;
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
} catch {
  sdkAvailable = false;
}

test('server constructs without error', { skip: sdkAvailable ? false : '@modelcontextprotocol/sdk is not installed (run npm ci first)' }, async () => {
  const { createServer } = await import('../src/server.mjs');
  const client = { get: async () => ({}) };
  const server = createServer({ client });
  assert.ok(server);
  assert.equal(typeof server.connect, 'function');
});
