import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesTrigger, workflowSummary, DEFAULT_WORKFLOWS } from '../lib/workflows.js';

// Pure logic only: lib/workflows.js imports lib/db.js as a side effect, but
// nothing here makes a datastore call, so this runs against the real cwd
// without touching .data (same rule as test/auth.test.js).

const TRIGGER = { classes: ['car', 'person'], minScore: 0.4, withinMs: 5 * 60_000, minDetections: 2 };
const det = (id, cls, score, at) => ({ id, class: cls, score, detected_at_ms: at });

test('fires when enough matching detections land inside the window', () => {
  const now = 1_000_000;
  const batch = [det('a', 'car', 0.9, now - 60_000), det('b', 'car', 0.8, now)];
  assert.equal(matchesTrigger(TRIGGER, batch, { now }).length, 2);
});

test('a detection below the score floor does not count', () => {
  const now = 1_000_000;
  const batch = [det('a', 'car', 0.9, now - 60_000), det('b', 'car', 0.2, now)];
  assert.equal(matchesTrigger(TRIGGER, batch, { now }).length, 0);
});

test('a matching class outside the window does not count', () => {
  const now = 1_000_000;
  const batch = [det('a', 'car', 0.9, now - 10 * 60_000), det('b', 'car', 0.8, now)];
  assert.equal(matchesTrigger(TRIGGER, batch, { now }).length, 0);
});

test('the window is measured from the newest detection in the batch', () => {
  // Both detections are 4 minutes apart; measured from the newest, the older
  // one is inside a 5-minute window even though it is 9 minutes older than
  // 'now'. This is what lets a burst straddling two scan calls count.
  const now = 1_000_000;
  const batch = [det('a', 'car', 0.9, now - 9 * 60_000), det('b', 'car', 0.8, now - 5 * 60_000)];
  assert.equal(matchesTrigger(TRIGGER, batch, { now }).length, 2);
});

test('unlisted classes never count, regardless of score', () => {
  const now = 1_000_000;
  const batch = [det('a', 'boat', 0.99, now - 60_000), det('b', 'boat', 0.99, now)];
  assert.equal(matchesTrigger(TRIGGER, batch, { now }).length, 0);
});

test('minDetections is a floor, not a target', () => {
  const now = 1_000_000;
  const batch = [det('a', 'car', 0.9, now - 60_000), det('b', 'car', 0.8, now), det('c', 'person', 0.7, now)];
  assert.equal(matchesTrigger(TRIGGER, batch, { now }).length, 3);
});

test('workflowSummary says the trigger in operator words', () => {
  const s = workflowSummary({ trigger: TRIGGER, actions: [{ type: 'alert' }, { type: 'webhook' }] });
  assert.match(s, /car, person/);
  assert.match(s, /40%/);
  assert.match(s, /2 in 5 min/);
  assert.match(s, /alert \+ webhook/);
});

test('the built-in traffic accident watch ships sane and enabled', () => {
  const wf = DEFAULT_WORKFLOWS.find((w) => w.id === 'def-traffic-accident');
  assert.ok(wf);
  assert.equal(wf.enabled, true);
  assert.ok(wf.trigger.classes.includes('car'));
  assert.ok(wf.trigger.minDetections >= 1);
  assert.ok(wf.actions.some((a) => a.type === 'alert'));
});
