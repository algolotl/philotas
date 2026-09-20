// Fire & emergency — NSW Rural Fire Service major incidents (keyless GeoJSON).
// The NSW RFS feed is STATEWIDE and unfiltered. Unclipped, a Sydney picture
// carries incidents 600km away on the Queensland border, and the ontology then
// resolves them against Sydney infrastructure as though they were local.
// Clipped to the region bbox here, same as the traffic camera feed.

const RFS = 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json';

function toPoint(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Point') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') {
    const pt = geometry.geometries.find((g) => g.type === 'Point');
    if (pt) return pt.coordinates;
    const poly = geometry.geometries.find((g) => g.coordinates);
    return poly ? flattenFirst(poly.coordinates) : null;
  }
  return flattenFirst(geometry.coordinates);
}

function flattenFirst(coords) {
  let c = coords;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return Array.isArray(c) ? c : null;
}

function field(desc, key) {
  if (!desc) return null;
  const m = new RegExp(`${key}:\\s*([^<]+)`, 'i').exec(desc);
  return m ? m[1].trim() : null;
}

function inBbox([lon, lat], b) {
  if (!b) return true;
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

export async function fetchFires(region) {
  const res = await fetch(RFS, { headers: { 'User-Agent': 'philotas-demo/0.1' } });
  if (!res.ok) throw new Error(`RFS ${res.status}`);
  const data = await res.json();

  const features = (data.features || [])
    .map((f) => {
      const coord = toPoint(f.geometry);
      if (!coord) return null;
      const p = f.properties || {};
      const desc = p.description || '';
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coord },
        properties: {
          layer: 'fires', title: p.title || 'Incident',
          category: p.category || field(desc, 'ALERT LEVEL') || 'Unknown',
          status: field(desc, 'STATUS'),
          fire: /fire/i.test(p.category || '') || /fire/i.test(desc),
          alert_level: field(desc, 'ALERT LEVEL'), size: field(desc, 'SIZE'),
          updated: p.pubDate || field(desc, 'UPDATED'), location: field(desc, 'LOCATION'),
        },
      };
    })
    .filter(Boolean)
    .filter((f) => inBbox(f.geometry.coordinates, region?.bbox));

  return { type: 'FeatureCollection', features, generated: Date.now() };
}
