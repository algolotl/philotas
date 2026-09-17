// Geo-anchors, bounding boxes and per-feed cache TTLs.
// Shared by the API route handlers (Node runtime) and safe to import anywhere.
//
// Sydney is the flagship region; Canberra anchors are retained because the
// Deep Space Network site is genuinely there and supplies the ontology's only
// structural (non-LLM) links.

export const CANBERRA = {
  name: 'Canberra',
  center: [149.1244, -35.3081], // Parliament House
  defaultZoom: 9,
};

export const SITES = [
  { id: 'yscb',  name: 'Canberra Airport / RAAF Fairbairn (YSCB)', kind: 'airfield', coord: [149.1951, -35.3069] },
  { id: 'aph',   name: 'Parliament House',                          kind: 'gov',      coord: [149.1244, -35.3081] },
  { id: 'cdscc', name: 'Canberra Deep Space Communication Complex (Tidbinbilla)', kind: 'space', coord: [148.9819, -35.4014] },
  { id: 'ga',    name: 'Geoscience Australia (Symonston)',          kind: 'science',  coord: [149.1430, -35.3440] },
];

export const ACT_BBOX = { west: 148.76, south: -35.92, east: 149.40, north: -35.12 };
export const REGION_BBOX = { west: 148.20, south: -36.60, east: 150.40, north: -34.40 };

import { CONNECTORS } from './connectors/registry.js';

// Transport for NSW enforces ONE quota across every API on the key, and this is
// it: 60,000 calls a day on the Bronze plan (5 req/s is the separate burst cap,
// handled by the shared queue in lib/tfnsw-limit.js). Named here because it is a
// fact about the account rather than about any one feed — the transport modes,
// the camera layer and the ingest service all spend from it, and until this
// existed each of them stated the number in a comment of its own.
//
// test/tfnsw-quota.test.js derives the day's total from the TTLs below and
// checks it against this. It is the ceiling every TTL edit here is spending
// against, so do not raise it to make a poll rate fit.
export const TFNSW_DAILY_CALL_QUOTA = 60_000;

const CORE_FEEDS = {
  // OpenSky's keyless tier rate-limits hard, especially the global (world) feed,
  // so we poll gently. Satellite positions are recomputed every 10s from TLEs
  // that are themselves cached 30 min (see feeds/satellites.js).
  aviation:   { ttl: 20_000,  label: 'Aviation (ADS-B / OpenSky)' },
  // Not "CelesTrak TLE" any more on either count: elements come from CelesTrak
  // GP JSON with SatNOGS DB as a keyless fallback, and CelesTrak itself is
  // retiring the TLE format because six-digit catalog numbers do not fit in it.
  satellites: { ttl: 10_000,  label: 'Satellites (overhead)' },
  // Vessels merge three sources: live TfNSW ferry positions, Port Authority of
  // NSW scheduled movements, and recorded positions from the datastore. Two of
  // those are upstream calls, so this is a politeness interval rather than the
  // pure database read the AIS-era comment described.
  vessels:    { ttl: 5_000,   label: 'Vessels (TfNSW + Port Authority NSW)' },
  // Transport fetches one endpoint per mode, so the cost is 5x the poll rate
  // against TFNSW_DAILY_CALL_QUOTA above: at 6s that is 72,000 calls/day on this
  // feed alone, over the limit, and it takes the camera layer down with it when
  // the quota goes. 10s gives 43,200/day and leaves room for cameras, the ingest
  // service and a second region. Lowering it means re-deriving the day's total —
  // test/tfnsw-quota.test.js does that arithmetic and will stop you.
  transport:  { ttl: 10_000,  label: 'Transport (GTFS-RT)' },
  cameras:    { ttl: 300_000, label: 'CCTV (traffic cameras)' },
  fires:      { ttl: 60_000,  label: 'Fire & emergency (NSW RFS)' },
  // Detections arrive on satellite overpass, so polling faster buys nothing.
  hotspots:   { ttl: 900_000, label: 'Fire hotspots (NASA FIRMS VIIRS)' },
  seismic:    { ttl: 120_000, label: 'Seismic (USGS / Geoscience Australia)' },
  weather:    { ttl: 120_000, label: 'Weather (BoM)' },
  // Served from the in-memory GKG window (lib/corpus/news-store.js), which
  // refreshes itself every 15 minutes regardless of this TTL. This is how often
  // a region re-filters that window, which is a local operation.
  news:       { ttl: 60_000, label: 'News (GDELT GKG)' },
  space:      { ttl: 15_000,  label: 'Deep space (NASA DSN — Tidbinbilla)' },
};

// Registered connectors join the core feeds automatically.
export const FEEDS = {
  ...CORE_FEEDS,
  ...Object.fromEntries(CONNECTORS.map((c) => [c.id, { ttl: c.ttl, label: c.label }])),
};
