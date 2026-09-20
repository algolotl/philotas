// Fire hotspots — NASA FIRMS active fire detections.
//
// Distinct from the `fires` layer, which is NSW RFS ground-reported incidents.
// This is what the satellite saw: a thermal anomaly at a point in time, with no
// human having assessed it. The two disagree usefully — a hotspot with no RFS
// incident is either a hazard reduction burn, an industrial source, or
// something nobody has called in yet.
//
// FIRMS returns CSV, not JSON. Requires a free MAP_KEY from
// https://firms.modaps.eosdis.nasa.gov/api/map_key/ (5,000 transactions per
// 10 minutes). Without a key the layer serves empty rather than failing, so an
// unconfigured deployment simply has no hotspot layer.
//
// Data courtesy of NASA LANCE/EOSDIS. See NOTICE.

const BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

// VIIRS on NOAA-20 at 375m is the best resolution/latency combination for
// near-real-time fire work. MODIS is coarser; SNPP duplicates NOAA-20 coverage.
const SOURCE = 'VIIRS_NOAA20_NRT';
const DAY_RANGE = 1;
const MAX_FEATURES = 1500;

// FIRMS confidence is 'l' | 'n' | 'h' for VIIRS (low/nominal/high).
const CONFIDENCE_LABEL = { l: 'low', n: 'nominal', h: 'high' };

// acq_date "2026-08-14" + acq_time "0713" -> epoch ms (times are UTC).
// Exported for testing only — fetchHotspots is the real entry point and the
// only one application code calls; nothing outside this module should import
// acquiredAtMs directly.
export function acquiredAtMs(date, time) {
  if (!date || !time) return null;
  const padded = String(time).padStart(4, '0');
  const ms = Date.parse(`${date}T${padded.slice(0, 2)}:${padded.slice(2)}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

// Minimal CSV parse. FIRMS emits plain comma-separated values with a header row
// and no quoting or embedded commas, so a full parser would be overkill.
// Exported for testing only — see the note on acquiredAtMs above.
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

export async function fetchHotspots(region) {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) {
    // Not an error: the deployment simply has no FIRMS key configured.
    return { type: 'FeatureCollection', features: [], generated: Date.now(), source: 'unconfigured',
             live: false, notice: 'Fire hotspots need a FIRMS MAP_KEY.' };
  }

  const b = region?.bbox;
  const area = b ? `${b.west},${b.south},${b.east},${b.north}` : 'world';
  const res = await fetch(`${BASE}/${key}/${SOURCE}/${area}/${DAY_RANGE}`, {
    headers: { 'User-Agent': 'philotas-demo/0.1' },
  });
  if (!res.ok) throw new Error(`FIRMS ${res.status}`);

  const text = await res.text();
  // FIRMS reports quota and key problems as a plain-text body with HTTP 200,
  // so a status check alone is not enough.
  if (/Invalid MAP_KEY|Transaction limit|error/i.test(text.slice(0, 200)) && !text.startsWith('latitude')) {
    throw new Error(`FIRMS: ${text.slice(0, 120).trim()}`);
  }

  const now = Date.now();
  const features = parseCsv(text)
    .map((row) => {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const acquired = acquiredAtMs(row.acq_date, row.acq_time);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          layer: 'hotspots',
          title: `Hotspot ${row.acq_date || ''} ${row.acq_time || ''}`.trim(),
          // Fire radiative power, in megawatts: how much energy the fire is
          // putting out. The most useful single number here.
          frp_mw: Number(row.frp) || null,
          brightness_k: Number(row.bright_ti4) || null,
          confidence: CONFIDENCE_LABEL[row.confidence] || row.confidence || null,
          satellite: row.satellite || null,
          instrument: row.instrument || null,
          daynight: row.daynight === 'D' ? 'day' : row.daynight === 'N' ? 'night' : null,
          acquired_at_ms: acquired,
          age_hours: acquired ? Math.round((now - acquired) / 3600000) : null,
        },
      };
    })
    .filter(Boolean)
    // Strongest first, so a cap keeps the significant detections.
    .sort((a, b2) => (b2.properties.frp_mw || 0) - (a.properties.frp_mw || 0))
    .slice(0, MAX_FEATURES);

  return { type: 'FeatureCollection', features, generated: now };
}
