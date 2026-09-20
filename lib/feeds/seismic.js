// Seismic — recent earthquakes from the USGS day-feed (keyless).
// Region-aware: a bounded region filters to its bbox; the world region shows
// every quake in the last 24 hours. Geoscience Australia is the authoritative
// national source for the Canberra region and sits down the road in Symonston.

const USGS_DAY = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

function inBox([lon, lat], b) {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

export async function fetchSeismic(region) {
  const bbox = region?.bbox;
  const res = await fetch(USGS_DAY, { headers: { 'User-Agent': 'philotas-demo/0.1' } });
  if (!res.ok) throw new Error(`USGS ${res.status}`);
  const data = await res.json();

  const features = (data.features || [])
    .filter((f) => f.geometry && (!bbox || inBox(f.geometry.coordinates, bbox)))
    .map((f) => {
      const p = f.properties || {};
      const [lon, lat, depth] = f.geometry.coordinates;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          layer: 'seismic', id: f.id, title: p.place || 'Earthquake', magnitude: p.mag,
          depth_km: depth, time: p.time, url: p.url, felt: p.felt,
        },
      };
    });

  return { type: 'FeatureCollection', features, generated: Date.now() };
}
