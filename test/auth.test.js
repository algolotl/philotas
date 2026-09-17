import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLeast } from '../lib/auth.js';

// atLeast() is the single choke point every route guard calls through
// (see lib/guard.js). Importing lib/auth.js pulls in lib/db.js as a side
// effect, but merely importing db.js does not touch the filesystem — the
// file backend only opens .data/parallax-db.json when a db call is actually
// made, and nothing here makes one. Safe to run against the real cwd.

test('viewer ranks below operator and admin', () => {
  assert.equal(atLeast('viewer', 'viewer'), true);
  assert.equal(atLeast('viewer', 'operator'), false);
  assert.equal(atLeast('viewer', 'admin'), false);
});

test('operator ranks at or above viewer and operator, below admin', () => {
  assert.equal(atLeast('operator', 'viewer'), true);
  assert.equal(atLeast('operator', 'operator'), true);
  assert.equal(atLeast('operator', 'admin'), false);
});

test('admin ranks at or above everything', () => {
  assert.equal(atLeast('admin', 'viewer'), true);
  assert.equal(atLeast('admin', 'operator'), true);
  assert.equal(atLeast('admin', 'admin'), true);
});

test('an unknown role is refused regardless of the minimum requested', () => {
  // RANK[role] ?? -1: an unrecognised role ranks below every real minimum,
  // including 'viewer' (rank 0). A typo'd or stale role value must not
  // silently pass as viewer-equivalent.
  assert.equal(atLeast('bogus', 'viewer'), false);
  assert.equal(atLeast(undefined, 'viewer'), false);
});

test('an unknown minimum refuses everyone, including admin', () => {
  // RANK[min] ?? 99: a typo'd minRole (e.g. passed by a route handler) fails
  // closed rather than silently admitting every role.
  assert.equal(atLeast('admin', 'bogus'), false);
});
