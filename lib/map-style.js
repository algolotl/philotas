// Basemap style resolver. The map is keyless MapLibre GL: no Google Maps, no
// API key. Defaults to the CARTO dark-matter vector style; deployments that
// self-host tiles (air-gapped) point NEXT_PUBLIC_MAP_STYLE_URL at their own
// style server.
export const DEFAULT_MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export function resolveMapStyle(value) {
  return value && value.trim() ? value.trim() : DEFAULT_MAP_STYLE;
}
