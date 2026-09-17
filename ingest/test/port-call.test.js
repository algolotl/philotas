import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPortCallMismatch } from '../src/detectors/port-call.js';

const now = 5000000;

const alongsideCircularQuay = {
  mmsi: '503111222',
  name: 'TEST CRUISER',
  points: [
    { timestamp_ms: now, position: [151.2105, -33.8613], speed_over_ground_knots: 0.1, course_over_ground_degrees: 0 },
  ],
};

// Includes a berth whose own name contains the word "SYDNEY" — this is what
// makes the generic-alias safeguard load-bearing rather than decorative: a
// naive token match on plain "SYDNEY" would otherwise flag every vessel
// alongside Circular Quay as mismatched against the anchorage.
const BERTHS = [
  { id: 'cq-2', name: 'Circular Quay Wharf 2', position: [151.2105, -33.8613], radius_metres: 120 },
  { id: 'pb-1', name: 'Port Botany — Patrick Terminal', position: [151.2260, -33.9740], radius_metres: 350 },
  { id: 'anchorage', name: 'Sydney Outer Anchorage', position: [151.3200, -33.8500], radius_metres: 2000 },
];

test('does not fire when the declared destination matches the berth alongside', () => {
  assert.equal(
    detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'CIRCULAR QUAY' }),
    null
  );
});

test('does not fire for a generic port-level destination like plain SYDNEY', () => {
  // "SYDNEY" is not wrong about a vessel alongside any Sydney berth, it is
  // just unspecific. A confident mismatch needs more than that — and one of
  // the BERTHS above literally has "Sydney" in its name, so this also proves
  // the generic-alias guard is doing real work, not just matching by luck.
  assert.equal(
    detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'SYDNEY' }),
    null
  );
});

test('does not fire when the destination is unrecognisable free text', () => {
  assert.equal(
    detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'NOON REPORT XJ4' }),
    null
  );
});

test('does not fire without a declared destination', () => {
  assert.equal(detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS }), null);
});

test('does not fire when the vessel is not alongside any known berth', () => {
  const inChannel = {
    mmsi: '503111222',
    points: [{ timestamp_ms: now, position: [151.25, -33.90], speed_over_ground_knots: 8, course_over_ground_degrees: 90 }],
  };
  assert.equal(
    detectPortCallMismatch(inChannel, now, { berths: BERTHS, destination: 'MELBOURNE' }),
    null
  );
});

test('fires when the destination names a different berth in the same list', () => {
  const event = detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'PORT BOTANY' });
  assert.ok(event, 'expected a port-call mismatch event');
  assert.equal(event.type, 'port_call_mismatch');
  assert.equal(event.mmsi, '503111222');
  assert.equal(event.berth_id, 'cq-2');
  assert.equal(event.berth_name, 'Circular Quay Wharf 2');
  assert.match(event.evidence, /PORT BOTANY/);
  assert.match(event.evidence, /Circular Quay Wharf 2/);
});

test('fires when the destination resolves to a known abbreviation for another berth', () => {
  // "AU PBY" is UN/LOCODE-shaped free text: country prefix + port code.
  const event = detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'AU PBY' });
  assert.ok(event, 'expected a mismatch — AU PBY resolves to Port Botany');
  assert.equal(event.matched_destination, 'PORT BOTANY');
});

test('fires when the destination is a real port known to be elsewhere entirely', () => {
  const event = detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'MELBOURNE' });
  assert.ok(event);
});

test('handles a multi-leg destination by reading only the immediate leg', () => {
  // "SYDNEY>MELBOURNE" declares Sydney now, Melbourne later. The immediate
  // leg agrees with a Sydney berth, so this must not fire even though
  // Melbourne appears later in the string.
  assert.equal(
    detectPortCallMismatch(alongsideCircularQuay, now, { berths: BERTHS, destination: 'SYDNEY>MELBOURNE' }),
    null
  );
});

test('is case- and punctuation-insensitive', () => {
  const event = detectPortCallMismatch(alongsideCircularQuay, now, {
    berths: BERTHS,
    destination: 'port botany.',
  });
  assert.ok(event);
});

test('stamps a stable started_at_ms so dedup ids do not change every pass', () => {
  // The mismatch persists while the vessel stays alongside, so each 30 s pass
  // fires again. recordEvent's id is `${type}:${mmsi}:${started_at_ms}`; the
  // start must be the oldest visible point, not a fresh `now`, or the open
  // event is never updated and the table fills with duplicates.
  const event = detectPortCallMismatch(alongsideCircularQuay, now, {
    berths: BERTHS,
    destination: 'MELBOURNE',
  });
  assert.ok(event, 'expected a port-call mismatch event');
  assert.equal(event.started_at_ms, now); // the single visible point IS the start
});

test('never reads points after now', () => {
  const withFutureBerthing = {
    mmsi: alongsideCircularQuay.mmsi,
    points: [
      { timestamp_ms: now, position: [151.25, -33.90], speed_over_ground_knots: 8, course_over_ground_degrees: 90 },
      { timestamp_ms: now + 60000, position: [151.2105, -33.8613], speed_over_ground_knots: 0, course_over_ground_degrees: 0 },
    ],
  };
  // At `now` the vessel is mid-channel, not alongside — the later berthing
  // must be invisible.
  assert.equal(
    detectPortCallMismatch(withFutureBerthing, now, { berths: BERTHS, destination: 'MELBOURNE' }),
    null
  );
});
