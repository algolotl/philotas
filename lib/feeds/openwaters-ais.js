// Gulf / global vessel positions from the Open Waters AIS network ("aiscast",
// https://openwaters.io/ais/).
//
// aiscast re-serves the AISHub worldwide terrestrial aggregate as GeoJSON and
// needs no token, which is what makes a shipping layer possible outside NSW at
// all: this project's other vessel sources — Transport for NSW ferries and Port
// Authority of NSW movements — are each a national data agreement, and neither
// reaches the Gulf.
//
// It is a beta with no SLA and uneven coverage, and it re-serves each event
// under the terms of the source it came from. Every response carries the
// attribution that has to be shown with the data (see `attribution` on the
// feature collection); this feed forwards it rather than inventing a credit
// line of its own.

const ENDPOINT = 'https://ais.openwaters.io/v1/vessels';

// Attribution required with the data. lib/feeds/vessels.js surfaces it on the
// payload so a UI can display it without knowing which source answered.
export const OPENWATERS_ATTRIBUTION =
  'AIS data: Open Waters AIS (https://openwaters.io/ais/) · AISHub (https://www.aishub.net)';

// AIS ship-type code -> the categories lib/layers.js styles. The code is the
// first digit of the ITU type field, so the ranges carry most of it and the
// exact values below are the ones the ranges get wrong.
export function shipTypeFromAisCode(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 70 && n <= 79) return 'cargo';
  if (n >= 80 && n <= 89) return 'tanker';
  if (n >= 60 && n <= 69) return 'passenger';
  if (n >= 40 && n <= 49) return 'passenger'; // high-speed craft are ferries in practice
  switch (n) {
    case 35: return 'naval';
    case 50: return 'pilot';
    case 31: case 32: case 52: case 53: return 'tug';
    case 36: case 37: return 'pleasure';
    default: return 'unknown';
  }
}

// One aiscast feature -> the vessel shape lib/feeds/vessels.js consumes.
// Exported for testing, as toFeature is in that file.
export function toVessel(feature, now) {
  const p = feature?.properties || {};
  const c = feature?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null;
  const seen = p.seen ? Date.parse(p.seen) : NaN;
  return {
    mmsi: p.mmsi ?? feature?.id ?? null,
    name: p.name || null,
    ship_type: shipTypeFromAisCode(p.type),
    position: c,
    speed_over_ground_knots: typeof p.sog === 'number' ? p.sog : null,
    course_over_ground_degrees: typeof p.cog === 'number' ? p.cog : null,
    heading: typeof p.heading === 'number' ? p.heading : null,
    last_report_ms: Number.isFinite(seen) ? seen : now,
    feed_source: 'aishub',
  };
}

export async function fetchOpenWatersVessels(region, { fetchImpl = fetch } = {}) {
  const b = region?.bbox;
  // No bbox means no spatial filter — the world view. aiscast would answer it,
  // but that is every vessel it is hearing anywhere, so refuse rather than pull
  // a global firehose into a single region's layer.
  if (!b) return [];
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const res = await fetchImpl(`${ENDPOINT}?bbox=${bbox}`, {
    headers: { 'User-Agent': 'philotas/0.1' },
  });
  if (!res.ok) throw new Error(`openwaters AIS HTTP ${res.status}`);
  const data = await res.json();
  const now = Date.now();
  return (data.features || []).map((f) => toVessel(f, now)).filter(Boolean);
}
