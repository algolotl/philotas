import { tfnswRequest } from '../tfnsw-limit.js';

// CCTV — traffic cameras.
//
// With CCTV_GEOJSON_URL set, this serves the TfNSW Live Traffic camera network
// (about 197 cameras statewide), each carrying the URL of its current JPEG.
// Without it, a small bundled set of ACT approach SITES stands in so the layer
// is not empty — locations only, no imagery.
//
// The upstream feed is statewide and unfiltered, so it is clipped to the
// region's bbox here. Serving all 197 to a Sydney view would put cameras in
// Wagga on the harbour picture.
//
// Licence note: the Open Data Hub publishes this dataset under CC BY 4.0, which
// plainly covers the GeoJSON. Whether that extends to the camera IMAGERY itself
// is not stated in the developer guide. Worth confirming with TfNSW before the
// stills are shown commercially.

// Approximate sites of NSW Live Traffic + Transport Canberra cameras on the
// main approaches. Coordinates are indicative, not surveyed.
const ACT_APPROACH_CAMERAS = [
  { name: 'Federal Hwy @ Sutton Rd',      road: 'Federal Highway', coord: [149.220, -35.182] },
  { name: 'Federal Hwy @ Lake George',    road: 'Federal Highway', coord: [149.400, -35.050] },
  { name: 'Barton Hwy @ Hall',            road: 'Barton Highway',  coord: [149.052, -35.162] },
  { name: 'Barton Hwy @ Murrumbateman',   road: 'Barton Highway',  coord: [149.030, -34.970] },
  { name: 'Kings Hwy @ Bungendore',       road: 'Kings Highway',   coord: [149.430, -35.252] },
  { name: 'Kings Hwy @ Kowen Forest',     road: 'Kings Highway',   coord: [149.320, -35.300] },
  { name: 'Monaro Hwy @ Hume',            road: 'Monaro Highway',  coord: [149.160, -35.400] },
  { name: 'Tuggeranong Pkwy @ Glenloch',  road: 'Tuggeranong Pkwy', coord: [149.080, -35.282] },
];

function staticCameras() {
  return ACT_APPROACH_CAMERAS.map((c) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: c.coord },
    properties: {
      layer: 'cameras', title: c.name, road: c.road,
      live: false, note: 'Live image requires a TfNSW Open Data key',
    },
  }));
}

function inBbox([lon, lat], b) {
  if (!b) return true;
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

export async function fetchCameras(region) {
  const url = process.env.CCTV_GEOJSON_URL;
  if (!url) {
    return {
      type: 'FeatureCollection',
      features: staticCameras().filter((f) => inBbox(f.geometry.coordinates, region?.bbox)),
      source: 'bundled',
      // The sites are real and correctly placed; it is the imagery that is
      // missing. Declared rather than inferred from the presence of a notice —
      // see the liveness comment in lib/feeds/satellites.js.
      live: false,
      notice: 'Camera sites only — set CCTV_GEOJSON_URL for live imagery.',
      generated: Date.now(),
    };
  }

  const headers = { 'User-Agent': 'parallax-demo/0.1' };
  if (process.env.CCTV_AUTH) {
    const i = process.env.CCTV_AUTH.indexOf(':');
    headers[process.env.CCTV_AUTH.slice(0, i).trim()] = process.env.CCTV_AUTH.slice(i + 1).trim();
  }
  // Same key, same 5/sec budget as the transport feed.
  const res = await tfnswRequest(() => fetch(url, { headers }));
  if (!res.ok) throw new Error(`CCTV ${res.status}`);
  const data = await res.json();

  const features = (data.features || [])
    .filter((f) => f?.geometry?.coordinates?.length === 2 && inBbox(f.geometry.coordinates, region?.bbox))
    .map((f) => {
      const p = f.properties || {};
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          layer: 'cameras',
          title: p.title || p.name || 'Camera',
          // What the camera is actually pointed at, which is the difference
          // between a dot on a map and something an operator can use.
          view: p.view || null,
          direction: p.direction || null,
          road: p.road || p.region || null,
          live: true,
          image: p.href || p.image || p.url || null,
        },
      };
    });

  return {
    type: 'FeatureCollection',
    features,
    source: 'live',
    // Carried through from the upstream feed rather than hardcoded, so the
    // attribution follows whatever TfNSW currently asserts.
    rights: data.rights || null,
    generated: Date.now(),
  };
}
