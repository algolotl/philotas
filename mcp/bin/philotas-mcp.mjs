#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from 'node:url';
import { createClient } from '../src/client.mjs';

const NL = String.fromCharCode(10);

export async function runDoctor({ env = process.env, stdout = process.stdout, fetchImpl } = {}) {
  const url = env.PHILOTAS_URL;
  const checks = [];
  if (!url) {
    checks.push({ check: 'PHILOTAS_URL set', pass: false, detail: 'not set' });
    checks.push({ check: 'GET /api/status returns 200', pass: false, detail: 'PHILOTAS_URL not set' });
  } else {
    checks.push({ check: 'PHILOTAS_URL set', pass: true, detail: url });
    try {
      const client = createClient({ baseUrl: url, fetchImpl });
      await client.get('/api/status');
      checks.push({ check: 'GET /api/status returns 200', pass: true, detail: 'ok' });
    } catch (err) {
      const detail = (err && err.message ? err.message : String(err)) + (err && err.status === 401 ? ' — deployment requires auth: set PHILOTAS_USER/PHILOTAS_PASSWORD or PHILOTAS_TOKEN' : '');
      checks.push({ check: 'GET /api/status returns 200', pass: false, detail });
    }
  }
  for (const c of checks) {
    stdout.write((c.pass ? 'PASS ' : 'FAIL ') + c.check + ' — ' + c.detail + NL);
  }
  const allPass = checks.every((c) => c.pass);
  stdout.write(allPass ? 'doctor: all checks passed' + NL : 'doctor: some checks failed' + NL);
  return allPass ? 0 : 1;
}

async function runServer() {
  const { startServer } = await import('../src/server.mjs');
  await startServer();
}

export function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (cmd === 'doctor') return runDoctor();
  if (cmd === undefined || cmd === '' || cmd === 'run') return runServer();
  process.stderr.write('philotas-mcp: unknown command "' + cmd + '"' + NL);
  process.stderr.write('usage: philotas-mcp [run|doctor]' + NL);
  return Promise.resolve(2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  });
}
