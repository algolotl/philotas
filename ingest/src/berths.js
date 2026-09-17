// Berth register for the loitering detector.
//
// Reads the SAME file the application's berths connector serves from, rather
// than keeping a copy here. The detector's idea of "at a berth" and the map's
// idea of where berths are must not drift apart, and a second copy is how that
// happens.
//
// Read at startup, not per detection pass: it is fixed infrastructure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BERTHS_PATH = path.resolve(here, '../../lib/data/sample-lake/berths.json');

let cached = null;

export function berthRecords() {
  if (cached) return cached;
  try {
    const rows = JSON.parse(readFileSync(BERTHS_PATH, 'utf8'));
    cached = rows.map((row) => ({
      id: row.id,
      name: row.name,
      position: [row.lon, row.lat], // GeoJSON order, as the detectors expect
      radius_metres: row.radius_metres,
      berth_type: row.berth_type,
    }));
  } catch (err) {
    // Without berths the loitering detector cannot tell a vessel working a
    // wharf from one holding station in a channel, so it would report every
    // berthed ship. Failing loudly is better than a board full of noise.
    console.error(`[ingest] could not read berths from ${BERTHS_PATH}: ${err.message}`);
    cached = [];
  }
  return cached;
}
