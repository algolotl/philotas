// Geodesy helpers for the app side.
//
// `ingest/src/geo.js` carries the same haversine. That duplication is
// deliberate: ingest is a separate package with its own lifecycle, deployed on
// its own, and a shared-module dependency between them would mean a workspace
// setup for one twelve-line function. If either changes, change both — there is
// a test on the ingest side pinning the Sydney Harbour distance.

const EARTH_RADIUS_METRES = 6371000;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

// Great-circle distance between two [lon, lat] points.
export function haversineMetres([fromLon, fromLat], [toLon, toLat]) {
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLon = toRadians(toLon - fromLon);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}
