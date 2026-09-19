// Vessels — every hull in the picture, from four real sources.
//
//   1. Position history written by parallax-ingest, so the map keeps working on
//      last-known state when the live sources are unreachable.
//   2. Global AIS from the Open Waters AIS network (aiscast), keyless and
//      worldwide. The only source that reaches outside NSW, and what carries
//      the Gulf and the other chokepoints.
//   3. Ferry positions, live, from Transport for NSW. Real tracks.
//   4. Commercial shipping from Port Authority of NSW: cargo, container,
//      tanker, cruise. Berth assignments rather than positions, so these are
//      placed AT their berth and marked `position_source: 'berth'`.
//
// The bundled sample fallback is gone. It existed because aisstream was the
// only vessel source and the provider went silent; with two real sources there
// is no longer any reason to draw invented ships. An empty layer is a truthful
// answer and the status strip already says so.

import { listVessels } from '../db.js';
import { fetchFerriesAsVessels } from './transport.js';
import { fetchOpenWatersVessels, OPENWATERS_ATTRIBUTION } from './openwaters-ais.js';

// The Port Authority movement source is a permissioned feed that is excluded
// from the public tree. It is imported lazily so the vessels layer — and the
// feed registry that imports it — still build when portauthority.js is absent;
// in that case the layer simply omits the source. `includePortAuthority: false`
// is the test seam for exercising that state without renaming files.
let portAuthorityModule = null;
let portAuthorityResolved = false;

async function loadPortMovements() {
  if (!portAuthorityResolved) {
    portAuthorityResolved = true;
    try {
      const mod = await import('./portauthority.js');
      portAuthorityModule = mod.fetchPortMovements || null;
    } catch {
      portAuthorityModule = null;
    }
  }
  return portAuthorityModule;
}

// How long since a vessel's last report before it stops being "current".
const STALE_AFTER_MS = 30 * 60 * 1000;

function inBbox([lon, lat], bbox) {
  if (!bbox) return true;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

// Exported for testing only — fetchVessels is the real entry point. Marked
// explicitly, as in lib/feeds/hotspots.js.
export function toFeature(vessel, { source, now }) {
  const ageMs = vessel.last_report_ms ? now - vessel.last_report_ms : null;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: vessel.position },
    properties: {
      layer: 'vessels',
      title: vessel.name || `MMSI ${vessel.mmsi}`,
      mmsi: vessel.mmsi,
      ship_type: vessel.ship_type || 'unknown',
      destination: vessel.destination || null,
      speed_knots: vessel.speed_over_ground_knots,
      course: vessel.course_over_ground_degrees,
      last_report_ms: vessel.last_report_ms ?? null,
      age_ms: ageMs,
      reporting: ageMs == null ? null : ageMs < STALE_AFTER_MS,
      source,
      // 'berth' when the position was inferred from a berth assignment rather
      // than observed. Absent means observed. This must survive to the UI: an
      // inferred position presented as a fix is exactly the kind of quiet
      // overclaim the rest of this build avoids.
      position_source: vessel.position_source || null,
      berth: vessel.berth || null,
      agent: vessel.agent || null,
      movement: vessel.movement || null,
      scheduled_ms: vessel.scheduled_ms ?? null,
      in_port: vessel.in_port ?? null,
      // True only for a hull that has NOT yet arrived. Drives the hollow
      // marker so a due arrival can never read as a present position.
      //
      // Derived from the source's own movement flag, not from the timestamp.
      // A first cut used `scheduled_ms > now`, which marked every vessel
      // currently in port with a departure booked for tomorrow as "expected"
      // and drew all 24 hollow — including the seven actually alongside. A
      // departure time in the future means the ship is HERE until it leaves.
      expected: vessel.movement === 'arrival' && vessel.scheduled_ms != null && vessel.scheduled_ms > now,
    },
  };
}

export async function fetchVessels(region, options = {}) {
  // Sources are injectable so the orchestration can be tested without a
  // network or a database. Production passes nothing and gets the real three.
  const {
    stored = listVessels,
    ferries = fetchFerriesAsVessels,
    openWaters = fetchOpenWatersVessels,
    portMovements,
    includePortAuthority = true,
  } = options;
  const now = Date.now();
  const collected = [];
  let sources = [];
  // Which sources actually threw. Only consulted when nothing at all came back:
  // a source failing while another carries the layer is a note, not an outage.
  const failures = [];

  // 1. Last-known state from the datastore, written by parallax-ingest. Keeps
  //    the layer populated when a live source is briefly unreachable.
  try {
    const rows = await stored(region?.bbox || null);
    if (rows?.length) {
      collected.push(...rows.map((v) => ({ ...v, feed_source: 'stored' })));
      sources.push('stored');
    }
  } catch (err) {
    failures.push({ source: 'stored', message: err?.message || String(err) });
    /* no datastore: the live sources still carry the layer */
  }

  // 2. Global AIS from the Open Waters AIS network (aiscast), re-serving the
  //    AISHub worldwide terrestrial aggregate. Keyless, and the only source
  //    that reaches anywhere outside NSW — this is what puts hulls on the Gulf
  //    chokepoints. Collected BEFORE the NSW sources on purpose: later sources
  //    win the MMSI (below), and a ferry or a port movement carries more than
  //    a bare AIS ping does.
  try {
    const rows = await openWaters(region);
    if (rows?.length) {
      collected.push(...rows);
      sources.push('aishub');
    }
  } catch (err) {
    failures.push({ source: 'aishub', message: err?.message || String(err) });
    /* global AIS unreachable: the NSW sources still carry the layer where they reach */
  }

  // 3. Sydney Ferries, live from Transport for NSW. Genuinely real vessels,
  //    genuinely berthing at the wharves in the berth register — which makes
  //    the resolved berthed_at links real rather than a demonstration over
  //    invented hulls. Available with no AIS subscription at all.
  try {
    const rows = await ferries(region);
    if (rows?.length) {
      collected.push(...rows);
      sources.push('tfnsw');
    }
  } catch (err) {
    failures.push({ source: 'tfnsw', message: err?.message || String(err) });
    /* ferries unavailable: the port schedule still carries the layer */
  }

  // 4. Commercial shipping from Port Authority of NSW. Used with permission.
  //    These rows carry a berth, not a coordinate, so the feed places them at
  //    the berth and flags that the position is inferred.
  //
  //    Resolved lazily: when the module is absent (the public tree ships
  //    without it) the layer omits this source rather than failing to build,
  //    and does not record an outage for a feed it does not carry.
  const portSource = includePortAuthority === false
    ? null
    : (portMovements !== undefined ? portMovements : await loadPortMovements());
  if (portSource) {
    try {
      const port = await portSource(region);
      const rows = port?.features || [];
      if (rows.length) {
        collected.push(...rows.map((f) => ({
          mmsi: f.properties.mmsi || `PANSW-${f.properties.title}`,
          name: f.properties.title,
          ship_type: f.properties.ship_type,
          destination: f.properties.destination,
          position: f.geometry.coordinates,
          speed_over_ground_knots: null,
          course_over_ground_degrees: null,
          last_report_ms: f.properties.scheduled_ms ?? now,
          scheduled_ms: f.properties.scheduled_ms ?? null,
          position_source: 'berth',
          berth: f.properties.berth,
          agent: f.properties.agent,
          movement: f.properties.movement,
          in_port: f.properties.in_port ?? null,
          feed_source: 'portauthority',
        })));
        sources.push('portauthority');
      }
    } catch (err) {
      failures.push({ source: 'portauthority', message: err?.message || String(err) });
      /* port movements unavailable: the other sources still stand */
    }
  }

  // Later sources win on a repeated MMSI. Order matters and is deliberate:
  // stored is collected first precisely so a live fix overwrites it.
  const byMmsi = new Map();
  for (const vessel of collected) {
    if (!vessel?.mmsi) continue;
    byMmsi.set(vessel.mmsi, vessel);
  }
  const vessels = [...byMmsi.values()];

  // The bbox filter runs BEFORE the source label, not after. Every source is
  // asked for every region, and the NSW ones answer with Sydney hulls wherever
  // they are asked — so naming the sources off the unfiltered set labelled a
  // Gulf region "tfnsw" on the strength of ferries it had already discarded.
  const visible = vessels.filter((vessel) => Array.isArray(vessel.position) && inBbox(vessel.position, region?.bbox));

  // Name only the sources that actually put something on this region's map, so
  // the label cannot claim a feed that contributed nothing visible.
  const surviving = new Set(visible.map((v) => v.feed_source).filter(Boolean));
  const source = surviving.size ? sources.filter((s) => surviving.has(s)).join('+') : 'none';

  const features = visible.map((vessel) => toFeature({ ...vessel }, { source: vessel.feed_source || source, now }));

  // A wholly empty layer can mean two opposite things and the operator has to
  // be able to tell them apart: the sources answered and nothing is there, or
  // the sources failed and nothing made it back. Only the second is an outage.
  //
  // `stored` is the one source that legitimately returns empty rather than
  // failing — an ingest that has written nothing yet is not an outage. So a
  // failure of stored alone, with both live sources silent, is not declared
  // down either. The live feeds carry the layer; a live feed that threw (as
  // opposed to simply reporting nothing) is the signal that the picture the
  // operator is looking at is not current.
  const liveSourcesFailed = failures.some((f) => f.source !== 'stored');
  const emptyIsOutage = visible.length === 0 && liveSourcesFailed;

  return {
    type: 'FeatureCollection',
    features,
    generated: now,
    source,
    // The credit the AIS licence requires, forwarded from the source rather than
    // restated here. Absent unless the global feed actually put hulls on the
    // map, so an operator is never shown a credit for data that is not there.
    ...(surviving.has('aishub') ? { attribution: OPENWATERS_ATTRIBUTION } : {}),
    // Mirrors lib/feeds/satellites.js's `live: false` for a genuinely
    // unavailable layer. `feedResultIsLive` (lib/feed-health.js) reads
    // `payload.live !== false`, so this is what moves the header chip and the
    // footer counters to "down" instead of presenting an empty outage as a
    // fresh live picture. The error also drives the chip independently.
    live: !emptyIsOutage,
    ...(emptyIsOutage
      ? { error: `No vessels — all live sources failed: ${failures.map((f) => `${f.source}: ${f.message}`).join('; ')}` }
      : {}),
    // Surfaced by the status strip so an operator can see what they are looking
    // at without reading the code.
    notice: visible.length === 0 ? emptyReason() : null,
  };
}

// Why the layer is empty, stated accurately.
//
// An earlier version said "no AIS key configured" unconditionally, which became
// false the moment a key was added and the real cause moved upstream. A notice
// that misstates its own reason is worse than none: it trains the operator to
// disregard it, and the next time it fires for a different reason they will not
// read it either. So name the actual condition.
function emptyReason() {
  if (!process.env.TFNSW_API_KEY) {
    return 'No vessels — the global AIS feed reported nothing in this region, and the Transport for NSW key is not configured for ferry positions.';
  }
  return 'No vessels currently reported by the global AIS feed, the ferry feed or the port movement schedule.';
}
