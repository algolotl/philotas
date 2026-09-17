import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runDetectors, DETECTORS } from '../src/detectors/index.js';

const carrier = JSON.parse(readFileSync(new URL('./fixtures/carrier-gap.json', import.meta.url)));

test('registry exposes every detector by name', () => {
  const names = DETECTORS.map((detector) => detector.name).sort();
  assert.deepEqual(names, [
    'ais_gap',
    'course_deviation',
    'identity_anomaly',
    'loitering',
    'port_call_mismatch',
  ]);
});

test('every registry name matches the event type its detector emits', () => {
  // A mismatch here would break any downstream filter on event type.
  const now = carrier.points.at(-1).timestamp_ms + 60 * 60 * 1000;
  const events = runDetectors(carrier, now, { berths: [] });
  const registryNames = new Set(DETECTORS.map((detector) => detector.name));
  for (const event of events) {
    assert.ok(registryNames.has(event.type), `${event.type} is not a registered detector name`);
  }
});

test('runDetectors returns the events that fired', () => {
  const now = carrier.points.at(-1).timestamp_ms + 60 * 60 * 1000;
  const events = runDetectors(carrier, now, { berths: [] });
  assert.ok(events.some((event) => event.type === 'ais_gap'));
});

test('runDetectors returns an empty array when nothing fires', () => {
  const now = carrier.points.at(-1).timestamp_ms + 1000;
  assert.deepEqual(runDetectors(carrier, now, { berths: [] }), []);
});

test('one detector throwing does not lose the others', () => {
  // This runs on every position report for every vessel. A single bad input
  // must not silence the whole analytical layer.
  const exploding = {
    name: 'boom',
    run: () => {
      throw new Error('detector fault');
    },
  };
  const now = carrier.points.at(-1).timestamp_ms + 60 * 60 * 1000;
  const events = runDetectors(carrier, now, {
    berths: [],
    detectors: [exploding, ...DETECTORS],
  });
  assert.ok(events.some((event) => event.type === 'ais_gap'), 'surviving detectors still report');
});
