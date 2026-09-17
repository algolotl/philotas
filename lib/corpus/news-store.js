// lib/corpus/news-store.js
//
// A bounded window of geocoded news records, shared by every region.
//
// The old design queried GDELT once per region and placed the results on an
// invented spiral. This holds one world-wide set and each region filters it by
// bounding box, so adding a region costs nothing upstream — which is the
// property that broke when the trial went from 3 regions to 19.
//
// In memory. The frame archive already persists what each region renders, so a
// restart costs the accumulated window and not the picture.

const RETENTION_HOURS = 24;
export const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

// One 15-minute file holds about 599 records and roughly all of them are
// located, so a day is on the order of 57,000. Capped so a stalled prune or an
// unusually large file cannot grow the heap without bound.
const MAX_RECORDS = 80_000;

const byId = new Map(); // id -> record

export function _reset() { byId.clear(); }

function prune(now) {
  const cutoff = now - RETENTION_MS;
  for (const [id, r] of byId) {
    if (r.dateMs < cutoff) byId.delete(id);
  }
  if (byId.size > MAX_RECORDS) {
    const sorted = [...byId.entries()].sort((a, b) => a[1].dateMs - b[1].dateMs);
    for (let i = 0; i < sorted.length - MAX_RECORDS; i++) byId.delete(sorted[i][0]);
  }
}

export function ingest(records, now = Date.now()) {
  let added = 0;
  let dropped = 0;
  const cutoff = now - RETENTION_MS;
  for (const r of records || []) {
    if (!r?.id || !Array.isArray(r.locations)) { dropped += 1; continue; }
    if (r.dateMs < cutoff) { dropped += 1; continue; }
    if (byId.has(r.id)) continue;
    byId.set(r.id, r);
    added += 1;
  }
  prune(now);
  return { added, dropped };
}

const inside = (lon, lat, b) => lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;

export function withinBbox(bbox, limit = 60, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  const hits = [];
  for (const r of byId.values()) {
    if (r.dateMs < cutoff) continue;
    // Placed at the first mentioned location inside the region. An article can
    // name several places; the one that put it in this region is the one that
    // belongs on this map.
    const where = bbox ? r.locations.find((l) => inside(l.lon, l.lat, bbox)) : r.locations[0];
    if (!where) continue;
    hits.push({ ...r, coord: [where.lon, where.lat], placedAt: where.name });
  }
  hits.sort((a, b) => b.dateMs - a.dateMs);
  return hits.slice(0, limit);
}

// O(1) resident-record count. Callers that only need the count (a notice
// string, a response field) should use this rather than stats(), which walks
// every record to also find the oldest/newest timestamp.
export function count() {
  return byId.size;
}

export function stats() {
  if (byId.size === 0) return { records: 0, oldestMs: null, newestMs: null };
  let oldest = Infinity;
  let newest = -Infinity;
  for (const r of byId.values()) {
    if (r.dateMs < oldest) oldest = r.dateMs;
    if (r.dateMs > newest) newest = r.dateMs;
  }
  return { records: byId.size, oldestMs: oldest, newestMs: newest };
}
