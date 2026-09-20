// Data-source connector pattern.
//
// A connector is ONE file describing a source: how it renders and how it pulls.
// Two kinds out of the box — `api` (fetch a URL, map JSON to GeoJSON) and
// `datalake` (run a query returning rows, map rows to GeoJSON) — but `pull` is
// just an async (region) => FeatureCollection, so anything goes.
//
// Connectors are CLIENT-SAFE at import (the map UI imports the registry for
// layer styling), so do any server-only work (datalake SDKs, fs) lazily INSIDE
// pull(), never at module top level.

export function defineConnector(c) {
  if (!c.id || typeof c.pull !== 'function') throw new Error(`connector "${c?.id}" needs an id and a pull()`);
  return {
    kind: 'api',
    ttl: 60_000,
    layer: { color: '#9ca3af', type: 'circle', radius: 5 },
    render: () => [],
    ...c,
  };
}

function inBbox([lon, lat], b) {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}

// API source: fetch (per region) and map the response to GeoJSON features.
export function apiPull({ url, normalize, headers }) {
  return async (region) => {
    const target = typeof url === 'function' ? url(region) : url;
    const res = await fetch(target, { headers: { 'User-Agent': 'philotas-demo/0.1', ...(headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const features = (normalize(data, region) || []).filter((f) => f?.geometry?.coordinates?.length === 2);
    return { type: 'FeatureCollection', features, generated: Date.now() };
  };
}

// Datalake source: run a query returning plain rows, map rows -> GeoJSON.
// `query` is the swap point: a bundled sample here, a Databricks / Snowflake /
// DuckDB-over-parquet / S3 client in production. Rows only need a lon/lat.
export function datalakePull({ query, toFeature, bbox = true }) {
  return async (region) => {
    const rows = await query(region);
    let features = (rows || []).map(toFeature).filter((f) => f?.geometry?.coordinates?.length === 2);
    if (bbox && region?.bbox) features = features.filter((f) => inBbox(f.geometry.coordinates, region.bbox));
    return { type: 'FeatureCollection', features, generated: Date.now() };
  };
}
