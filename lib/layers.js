// Client-safe layer descriptors: draw order, colour, label, render style.
// No server imports — safe to use in client components.

import { CONNECTORS } from './connectors/registry.js';

// Colours form the operational layer ramp against a #0B1B33 page. The maritime
// layers take the brand cyan end of it (#6FD3F2) so the sea domain reads as one
// family against the air and land layers. No two domains sit closer than about
// deltaE 17, so no two of them read as the same dot on a dense picture.
const CORE_LAYERS = [
  { id: 'aviation',   color: '#38bdf8', label: 'Aviation',               type: 'aircraft', trail: true },
  { id: 'satellites', color: '#e2e8f0', label: 'Satellites (overhead)',  type: 'circle', radius: 3 },
  // Not "Vessels (AIS)". AIS was removed on 2026-08-14; the hulls here come
  // from Transport for NSW and Port Authority of NSW, so naming the layer after
  // a feed it no longer carries told the operator something untrue.
  { id: 'vessels',    color: '#6FD3F2', label: 'Vessels',                type: 'vessel', trail: true },
  // Not "Transport". Next to Vessels and Aviation on a maritime picture that
  // read as a road-traffic overlay, and the trails reinforced it, so the layer
  // looked like a congestion map rather than what it is. Measured on the live
  // Sydney feed 2026-08-17: 3,506 individual vehicles, every geometry a Point,
  // each carrying its route, scheduled trip, heading and speed — 3,201 buses,
  // 246 trains, 23 ferries, 19 metro, 17 light rail. Every one is clickable and
  // named: "08:19am Cockatoo Island - Circular Quay", not a flow arrow.
  { id: 'transport',  color: '#A855F7', label: 'Public transport (live)', type: 'vehicle', trail: true },
  { id: 'cameras',    color: '#94a3b8', label: 'CCTV',                   type: 'camera', radius: 5 },
  { id: 'space',      color: '#a78bfa', label: 'Deep space (DSN)',       type: 'circle', radius: 7 },
  { id: 'fires',      color: '#f97316', label: 'Fire / emergency',       type: 'circle', radius: 6 },
  { id: 'hotspots',   color: '#EF4444', label: 'Hotspots (satellite)',   type: 'quake' },
  { id: 'seismic',    color: '#fbbf24', label: 'Seismic',                type: 'quake' },
  { id: 'weather',    color: '#34d399', label: 'Weather (BoM)',          type: 'circle', radius: 6 },
  { id: 'news',       color: '#f472b6', label: 'News / GDELT',           type: 'circle', radius: 5 },
];

// Vessel and transport sub-types, used by the layer control to group by domain
// rather than by source. Grouping by source is how you end up with a legend
// nobody reads.
export const VESSEL_TYPES = [
  { id: 'passenger', label: 'Ferry / passenger', color: '#6FD3F2' },
  { id: 'cruise',    label: 'Cruise',            color: '#A78BFA' },
  { id: 'cargo',     label: 'Cargo / container', color: '#3FA2E8' },
  { id: 'tanker',    label: 'Tanker',            color: '#F59E0B' },
  { id: 'tug',       label: 'Tug / workboat',    color: '#8B81FF' },
  { id: 'naval',     label: 'Naval',             color: '#EF4444' },
  { id: 'pilot',     label: 'Pilot',             color: '#14B8A6' },
  { id: 'pleasure',  label: 'Pleasure craft',    color: '#9FB2CC' },
  { id: 'unknown',   label: 'Unknown',           color: '#7E93AD' },
];

export const TRANSPORT_MODES = [
  { id: 'Ferry',      label: 'Ferry',      color: '#6FD3F2' },
  { id: 'Train',      label: 'Train',      color: '#A855F7' },
  { id: 'Bus',        label: 'Bus',        color: '#3B82F6' },
  { id: 'Light rail', label: 'Light rail', color: '#8B81FF' },
  { id: 'Metro',      label: 'Metro',      color: '#14B8A6' },
];

// Registered connectors contribute their own layer styling.
export const LAYERS = [
  ...CORE_LAYERS,
  ...CONNECTORS.map((c) => ({ id: c.id, label: c.label, ...c.layer })),
];

// What each vessel feed is, in the words an operator would use rather than the
// internal source id. `stored` is position history written by philotas-ingest,
// so it is a real observation that may simply be older than this poll.
const VESSEL_SOURCE_LABELS = {
  tfnsw: 'Transport for NSW — live ferry position',
  portauthority: 'Port Authority of NSW — scheduled movement',
  stored: 'philotas-ingest — recorded position',
};

// Per-layer formatting for the selection panel + popup. Connector renderers
// are merged in below.
const CORE_RENDERERS = {
  aviation: (p) => [
    ['callsign', p.callsign], ['icao24', p.id], ['country', p.country],
    ['altitude', p.altitude_m != null ? `${Math.round(p.altitude_m)} m` : null],
    ['speed', p.velocity_ms != null ? `${Math.round(p.velocity_ms * 3.6)} km/h` : null],
    ['heading', p.heading != null ? `${Math.round(p.heading)}°` : null],
    ['squawk', p.squawk], ['on ground', p.on_ground ? 'yes' : 'no'],
  ],
  satellites: (p) => [
    ['NORAD', p.norad], ['altitude', p.altitude_km != null ? `${p.altitude_km} km` : null],
    // Elevation is measured from the region's own centre, so the label must not
    // name a fixed city — this read "over Canberra" in the Sydney view.
    ['elevation', p.elevation_deg != null ? `${p.elevation_deg}° above the horizon` : null],
    ['speed', p.speed_kms != null ? `${p.speed_kms} km/s` : null],
  ],
  vessels: (p) => [
    ['MMSI', p.mmsi], ['type', p.ship_type], ['destination', p.destination],
    ['berth', p.berth],
    // An inferred berth placement must never read as an observed fix, and a
    // scheduled arrival must never read as a hull alongside.
    ['status', p.position_source === 'berth'
      ? (p.expected ? 'DUE — not yet alongside' : 'alongside (position inferred from berth)')
      : null],
    ['movement', p.movement],
    ['scheduled', p.scheduled_ms ? new Date(p.scheduled_ms).toLocaleString() : null],
    ['agent', p.agent],
    ['speed', p.speed_knots != null ? `${p.speed_knots} kn` : null],
    ['course', p.course != null ? `${Math.round(p.course)}°` : null],
    ['last report', p.last_report_ms ? new Date(p.last_report_ms).toLocaleTimeString() : null],
    ['reporting', p.reporting === false ? 'NO — transmission gap' : p.reporting ? 'yes' : null],
    // Name the feed this hull actually came from. This used to read
    // "live AIS" for anything that was not the bundled sample, which survived
    // the removal of AIS and went on labelling every TfNSW ferry and every
    // Port Authority movement as an AIS contact.
    ['source', VESSEL_SOURCE_LABELS[p.source] || p.source || null],
  ],
  transport: (p) => [
    ['mode', p.mode], ['route', p.route], ['vehicle', p.label],
    ['speed', p.speed_kmh != null ? `${p.speed_kmh} km/h` : null],
    ['bearing', p.bearing != null ? `${Math.round(p.bearing)}°` : null],
    ['updated', p.ts ? new Date(p.ts).toLocaleTimeString() : null],
  ],
  cameras: (p) => [
    ['view', p.view], ['facing', p.direction], ['region', p.road],
    ['status', p.live ? 'live image' : 'site only (no key)'],
    ['note', p.note],
    // Inline the still rather than only linking it: an operator checking a
    // camera wants the picture, not a new tab.
    ['image', p.image
      ? `<a href="${p.image}" target="_blank" rel="noopener"><img src="${p.image}" alt="" style="width:100%;max-width:260px;border-radius:3px;display:block;margin-top:4px"></a>`
      : null],
  ],
  fires: (p) => [['category', p.category], ['alert', p.alert_level], ['status', p.status], ['size', p.size], ['location', p.location], ['updated', p.updated]],
  hotspots: (p) => [
    ['power', p.frp_mw != null ? `${p.frp_mw} MW` : null],
    ['brightness', p.brightness_k != null ? `${p.brightness_k} K` : null],
    ['confidence', p.confidence], ['satellite', p.satellite],
    ['pass', p.daynight],
    ['detected', p.age_hours != null ? `${p.age_hours}h ago` : null],
    ['source', 'NASA FIRMS / LANCE'],
  ],
  seismic: (p) => [['magnitude', p.magnitude], ['depth', p.depth_km != null ? `${p.depth_km} km` : null], ['felt reports', p.felt], ['time', p.time ? new Date(p.time).toLocaleString() : null]],
  weather: (p) => [['temp', p.air_temp != null ? `${p.air_temp} °C` : null], ['feels like', p.apparent_t != null ? `${p.apparent_t} °C` : null], ['wind', p.wind_spd_kmh != null ? `${p.wind_dir} ${p.wind_spd_kmh} km/h` : null], ['gust', p.gust_kmh != null ? `${p.gust_kmh} km/h` : null], ['humidity', p.rel_humidity != null ? `${p.rel_humidity}%` : null], ['rain', p.rain_trace != null ? `${p.rain_trace} mm` : null], ['observed', p.observed]],
  news: (p) => [['source', p.domain], ['country', p.country], ['seen', p.seendate], ['link', p.url ? `<a href="${p.url}" target="_blank" rel="noopener" style="color:#38bdf8">open ↗</a>` : null]],
  space: (p) => [['dish', p.friendly], ['tracking', p.tracking || 'idle'], ['elevation', p.elevation ? `${(+p.elevation).toFixed(1)}°` : null], ['azimuth', p.azimuth ? `${(+p.azimuth).toFixed(1)}°` : null], ['downlink', p.downlink_rate]],
};

export const RENDERERS = {
  ...CORE_RENDERERS,
  ...Object.fromEntries(CONNECTORS.map((c) => [c.id, c.render])),
};
