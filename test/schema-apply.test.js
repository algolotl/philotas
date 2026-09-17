// test/schema-apply.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySemanticSchema } from '../lib/schema/apply.js';

test('without a database it declines rather than throwing', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const r = await applySemanticSchema(null);
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'no-database');
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});

test('it runs the DDL exactly once per pool', async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://stub/stub';
  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return { rows: [] }; } };
  try {
    const first = await applySemanticSchema(pool);
    assert.equal(first.applied, true);
    assert.equal(queries.length, 1, 'the whole file is applied in one statement');
    assert.match(queries[0], /CREATE TABLE IF NOT EXISTS chunks/);
    assert.match(queries[0], /VECTOR\(1024\)/);
    assert.doesNotMatch(queries[0], /USING hnsw/, 'no HNSW index at this stage; see the spec');

    const second = await applySemanticSchema(pool);
    assert.equal(second.applied, false);
    assert.equal(second.reason, 'already-applied');
    assert.equal(queries.length, 1, 'a second call does not re-run the DDL');
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
