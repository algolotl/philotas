// philotas-ingest — entry point.
//
//   TfNSW ferry positions -> vessel state -> detectors -> Postgres
//
// No HTTP surface. The service only writes; the application only reads. That
// separation is what lets the map keep working on last-known state when this
// process is down, which matters because this is the component most exposed to
// an upstream it does not control.
//
// The aisstream source was removed after the provider went silent — it
// accepted subscriptions and delivered nothing, worldwide, published no terms
// of service, and left a year of unanswered issues asking whether commercial
// use was permitted. Commercial shipping now arrives through the Port Authority
// of NSW feed on the application side (berth-placed, no tracks); ferries supply
// the position series these detectors need.
//
// Env:
//   TFNSW_API_KEY required. Transport for NSW Open Data token.
//   DATABASE_URL  required. Same database the app reads.
//   AIS_REGION    region id recorded on events. Default 'sydney'.

import {
  createVesselState,
  applyReport,
  getTrack,
  allVessels,
  pruneStale,
  getObservedNames,
  recordObservedName,
} from './vessel-state.js';
import { runDetectors } from './detectors/index.js';
import { createFerrySource } from './ferry-source.js';
import { createStore } from './store.js';
import { berthRecords } from './berths.js';

const REGION = process.env.AIS_REGION || 'sydney';
// Matches the Sydney region bbox in lib/regions.js.
const BBOX = { west: 150.4, south: -34.3, east: 151.7, north: -33.4 };

const FLUSH_INTERVAL_MS = 10_000;      // batch writes
const DETECT_INTERVAL_MS = 30_000;     // run detectors over the fleet
const PRUNE_INTERVAL_MS = 30 * 60_000; // trim position history
const POSITION_RETENTION_MS = 24 * 60 * 60_000;
const VESSEL_STALE_MS = 6 * 60 * 60_000;

const apiKey = process.env.TFNSW_API_KEY;
const connectionString = process.env.DATABASE_URL;

if (!apiKey) { console.error('[ingest] TFNSW_API_KEY is required'); process.exit(1); }
if (!connectionString) { console.error('[ingest] DATABASE_URL is required'); process.exit(1); }

const state = createVesselState();
const store = createStore({ connectionString });
const berths = berthRecords();

// Reports seen since the last flush, so a burst writes once.
let dirty = new Map();      // mmsi -> vessel
let pendingPositions = [];

const client = createFerrySource({
  apiKey,
  onReport(report) {
    // A static report carries identity but no position, so it updates the
    // vessel record without appending to the track.
    if (report.kind === 'static') {
      const existing = state.vessels.get(report.mmsi);
      if (!existing) return; // nothing to attach it to yet
      const merged = {
        ...existing,
        name: report.name ?? existing.name,
        ship_type: report.ship_type ?? existing.ship_type,
        destination: report.destination ?? existing.destination,
      };
      state.vessels.set(report.mmsi, merged);
      // Feeds the identity-anomaly detector's name history — a static frame
      // is exactly how a real name change (reflag, MMSI collision) would
      // usually arrive, since it carries identity rather than position.
      recordObservedName(state, report.mmsi, report.name, report.timestamp_ms ?? Date.now());
      dirty.set(report.mmsi, merged);
      return;
    }

    // Reports without a usable timestamp are stamped on arrival. Detectors
    // depend on monotonic time, and a null would poison the cadence baseline.
    const timestamp = report.timestamp_ms ?? Date.now();
    const { vessel } = applyReport(state, { ...report, timestamp_ms: timestamp });
    if (!vessel) return;
    dirty.set(report.mmsi, vessel);
    pendingPositions.push({
      mmsi: report.mmsi,
      timestamp_ms: timestamp,
      position: report.position,
      speed_over_ground_knots: report.speed_over_ground_knots,
      course_over_ground_degrees: report.course_over_ground_degrees,
    });
  },
});

setInterval(async () => {
  if (dirty.size === 0 && pendingPositions.length === 0) return;
  const vessels = [...dirty.values()];
  const positions = pendingPositions;
  try {
    await store.flushVessels(vessels);
    await store.appendPositions(positions);
    // Cleared ONLY after both writes succeeded. Clearing before the awaits
    // meant a failed flush permanently dropped the whole batch — every
    // position report that arrived during the outage was gone with a single
    // console.error and no retry. Keeping the buffers on failure re-queues the
    // batch for the next tick, so a transient DB outage costs freshness, not
    // data. The downside is bounded: a permanently-dead DB grows the buffer
    // once per interval, and a new process picks up clean state.
    dirty = new Map();
    pendingPositions = [];
  } catch (err) {
    console.error(`[ingest] flush failed, ${vessels.length} vessels and ${positions.length} positions kept for retry:`, err.message);
  }
}, FLUSH_INTERVAL_MS);

setInterval(async () => {
  const now = Date.now();
  let fired = 0;
  for (const vessel of allVessels(state)) {
    const track = getTrack(state, vessel.mmsi);
    if (!track) continue;
    const events = runDetectors({ ...track, name: vessel.name }, now, {
      berths,
      destination: vessel.destination,
      observedNames: getObservedNames(state, vessel.mmsi),
    });
    for (const event of events) {
      try { await store.recordEvent(event, REGION); fired += 1; } catch (err) {
        console.error('[ingest] event write failed:', err.message);
      }
    }
  }
  const removed = pruneStale(state, now, VESSEL_STALE_MS);
  const { messages, connected } = client.stats();
  console.log(`[ingest] ${allVessels(state).length} vessels, ${fired} events, ${messages} msgs, connected=${connected}, pruned=${removed}`);
}, DETECT_INTERVAL_MS);

setInterval(async () => {
  try {
    const n = await store.pruneOlderThan(Date.now() - POSITION_RETENTION_MS);
    if (n) console.log(`[ingest] pruned ${n} position rows`);
  } catch (err) { console.error('[ingest] prune failed:', err.message); }
}, PRUNE_INTERVAL_MS);

const shutdown = async (signal) => {
  console.log(`[ingest] ${signal}, shutting down`);
  client.stop();
  await store.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log(`[ingest] started for region '${REGION}', ${berths.length} berths loaded`);
