import { test } from 'node:test';
import assert from 'node:assert/strict';

import { record, latest, history, REPLAY_STEP_MS } from '../lib/store.js';

// The replay bar animates only if every layer covers the same stretch of wall
// clock. It previously did not: the store kept the last 60 frames per feed
// regardless of how fast that feed polled, so 60 frames of vessels (5s poll)
// was five minutes and 60 frames of cameras (300s poll) was five hours. The
// scrub then spanned the widest layer while the fast ones had nothing to draw
// over most of it, which is what "a couple of items jump at the end" was.

const fc = (n) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [151.2 + i * 0.001, -33.85] },
    properties: { id: i },
  })),
});

test('a feed polling faster than the cadence does not earn extra frames', () => {
  const feed = 'fast-poller';
  // Twelve polls in well under one cadence interval, as a 5s feed would do.
  for (let i = 0; i < 12; i += 1) record(feed, 'test', fc(i + 1));

  const frames = history(feed, 'test');
  assert.equal(frames.length, 1, 'a burst inside one interval is one frame, not twelve');
});

test('the newest frame still tracks the newest poll', () => {
  const feed = 'freshness';
  record(feed, 'test', fc(3));
  record(feed, 'test', fc(9));

  // Frames are rationed; currency is not. lib/cache.js falls back to latest()
  // when an upstream call fails, so collapsing a burst must not leave that
  // fallback holding the first payload of the interval.
  assert.equal(latest(feed, 'test').fc.features.length, 9);
  assert.equal(history(feed, 'test').length, 1);
});

test('feeds polling at different rates keep the same frame cadence', () => {
  // The property the replay depends on, stated directly: two feeds whose poll
  // rates differ by 60x produce the same number of frames over the same span.
  const fast = 'cadence-fast';
  const slow = 'cadence-slow';
  const t0 = Date.now();

  // Simulated dispatch times: `fast` every 5s, `slow` every 300s, over 20 min.
  // record() reads the real clock, so drive it through a stub rather than
  // sleeping — the assertion is about the ratio, not about timers.
  const dispatches = (intervalMs, spanMs) =>
    Array.from({ length: Math.floor(spanMs / intervalMs) }, (_, i) => t0 + i * intervalMs);

  const spanMs = 20 * 60 * 1000;
  const realNow = Date.now;
  try {
    for (const at of dispatches(5_000, spanMs)) { Date.now = () => at; record(fast, 'test', fc(1)); }
    for (const at of dispatches(300_000, spanMs)) { Date.now = () => at; record(slow, 'test', fc(1)); }
  } finally {
    Date.now = realNow;
  }

  const fastFrames = history(fast, 'test').length;
  const slowFrames = history(slow, 'test').length;

  // 20 minutes at a 30s cadence is 40 frames. The fast feed hits that ceiling;
  // the slow feed cannot beat its own poll rate, so it gets one per 300s.
  assert.equal(fastFrames, Math.floor(spanMs / REPLAY_STEP_MS));
  assert.equal(slowFrames, Math.ceil(spanMs / 300_000));
  assert.ok(
    fastFrames < 60 * slowFrames,
    'a 60x faster poll must not buy 60x the frames — that is the bug this pins'
  );
});

test('frames older than the retention window are dropped', () => {
  const feed = 'retention';
  const realNow = Date.now;
  const t0 = realNow();
  try {
    // One frame three hours ago, one now. The window is two hours.
    Date.now = () => t0 - 3 * 60 * 60 * 1000;
    record(feed, 'test', fc(1));
    Date.now = () => t0;
    record(feed, 'test', fc(2));
  } finally {
    Date.now = realNow;
  }

  const frames = history(feed, 'test');
  assert.equal(frames.length, 1, 'the three-hour-old frame is outside the window');
  assert.equal(frames[0].fc.features.length, 2);
});

test('history is scoped per region', () => {
  record('shared', 'sydney', fc(4));
  record('shared', 'canberra', fc(7));

  assert.equal(latest('shared', 'sydney').fc.features.length, 4);
  assert.equal(latest('shared', 'canberra').fc.features.length, 7);
});
