// Detector registry. Adding a detector means adding one entry here.
//
// A fault in one detector must never suppress the others: this runs on every
// position report for every vessel, so a single malformed input would otherwise
// silence the whole analytical layer.
//
// Every `name` here must equal the `type` its detector emits — downstream
// filtering keys off event type, and there is a test asserting they agree.

import { detectGap } from './gap.js';
import { detectLoitering } from './loitering.js';
import { detectDeviation } from './deviation.js';
import { detectPortCallMismatch } from './port-call.js';
import { detectIdentityAnomaly } from './identity.js';

export const DETECTORS = [
  { name: 'ais_gap', run: (track, now, context) => detectGap(track, now, context) },
  { name: 'loitering', run: (track, now, context) => detectLoitering(track, now, context) },
  { name: 'course_deviation', run: (track, now, context) => detectDeviation(track, now, context) },
  { name: 'port_call_mismatch', run: (track, now, context) => detectPortCallMismatch(track, now, context) },
  { name: 'identity_anomaly', run: (track, now, context) => detectIdentityAnomaly(track, now, context) },
];

export function runDetectors(track, now, context = {}) {
  const detectors = context.detectors || DETECTORS;
  const events = [];
  for (const detector of detectors) {
    try {
      const event = detector.run(track, now, context);
      if (event) events.push(event);
    } catch (error) {
      // Surface it, but keep going — see the note above.
      console.error(`[detector:${detector.name}] failed for ${track.mmsi}:`, error.message);
    }
  }
  return events;
}
