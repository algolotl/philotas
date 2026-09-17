// Geodesy helpers for the detectors.
// All coordinates are GeoJSON order: [longitude, latitude]. Every feed in this
// codebase uses that order, and mixing it is the most common bug in the domain.

const EARTH_RADIUS_METRES = 6371000;
const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

// Great-circle distance between two [lon, lat] points.
export function haversineMetres([fromLon, fromLat], [toLon, toLat]) {
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLon = toRadians(toLon - fromLon);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Destination point given a start, an initial bearing and a distance.
// This is how a gap's projected position cone gets centred.
export function projectPosition([lon, lat], bearingDegrees, distanceMetres) {
  const angularDistance = distanceMetres / EARTH_RADIUS_METRES;
  const bearing = toRadians(bearingDegrees);
  const lat1 = toRadians(lat);
  const lon1 = toRadians(lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  // Normalise longitude to [-180, 180).
  return [((toDegrees(lon2) + 540) % 360) - 180, toDegrees(lat2)];
}

// Median gap between consecutive ascending timestamps.
//
// This is the per-vessel reporting baseline. A ferry reports every few seconds
// and an anchored bulk carrier every few minutes, so a global constant would
// either drown the operator in false positives or miss everything. Median
// rather than mean because a single long gap must not drag the baseline out
// and mask the very condition being detected.
export function medianIntervalMs(timestampsAscending) {
  if (!Array.isArray(timestampsAscending) || timestampsAscending.length < 2) return null;
  const intervals = [];
  for (let i = 1; i < timestampsAscending.length; i += 1) {
    intervals.push(timestampsAscending[i] - timestampsAscending[i - 1]);
  }
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  return intervals.length % 2 === 0
    ? (intervals[middle - 1] + intervals[middle]) / 2
    : intervals[middle];
}
