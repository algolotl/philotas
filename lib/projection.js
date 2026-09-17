// Dead-reckoning projection for moving contacts.
//
// Two jobs, and it is worth being clear which is which.
//
//   1. A smoother picture. AIS arrives irregularly — a few seconds for a ferry,
//      minutes for a vessel at anchor. Between reports a contact sits frozen on
//      the map. Projecting it forward along its last known course and speed
//      keeps the picture moving without inventing anything: this is dead
//      reckoning, the same arithmetic a navigator does on paper.
//
//   2. Cheaper polling. Where a source is polled rather than streamed and
//      charges per call, projection lets you poll less often for the same
//      apparent freshness. The saving is real but bounded by the error below.
//
// Deliberately NOT a model. Position, course, speed and elapsed time fully
// determine the answer; there is nothing for a model to add, and an
// unauditable projection would contradict the rule the rest of the analytical
// layer follows. `measureProjectionError` exists so the accuracy of this can be
// stated as a number rather than asserted as a quality.
//
// Every projected position is marked as projected. A projection is a guess, and
// a picture that cannot distinguish a guess from a report is worse than one
// that leaves the contact still.

import { haversineMetres } from './geo.js';

const EARTH_RADIUS_METRES = 6371000;
const KNOTS_TO_METRES_PER_SECOND = 0.514444;
const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

const DEFAULTS = {
  // Below this the contact is effectively stationary and projecting it just
  // adds jitter around a berth.
  minimumSpeedKnots: 0.5,
  // Beyond this the vessel has probably manoeuvred, and a straight-line guess
  // stops being defensible. Refusing to project is the honest answer.
  maximumHorizonMs: 10 * 60 * 1000,
  // Positional uncertainty grows with distance run. Empirically the dominant
  // term is course change, not speed error — see measureProjectionError.
  uncertaintyFraction: 0.15,
  minimumUncertaintyMetres: 25,
};

// Destination point given a start, an initial bearing and a distance.
// Mirrors ingest/src/geo.js — see the note there on the duplication.
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
  return [((toDegrees(lon2) + 540) % 360) - 180, toDegrees(lat2)];
}

// Project a contact forward to `now`.
//
// Returns null when projection is not defensible — stationary, no course, no
// speed, no timestamp, or too long since the last fix. Null means "leave it
// where it was reported", which is always a safe answer.
export function projectContact(contact, now, options = {}) {
  const config = { ...DEFAULTS, ...options };

  const lastMs = contact?.last_report_ms;
  const position = contact?.position;
  const speedKnots = contact?.speed_over_ground_knots;
  const courseDegrees = contact?.course_over_ground_degrees;

  if (!Array.isArray(position) || position.length !== 2) return null;
  if (!Number.isFinite(lastMs)) return null;
  if (!Number.isFinite(speedKnots) || speedKnots < config.minimumSpeedKnots) return null;
  if (!Number.isFinite(courseDegrees)) return null;

  const elapsedMs = now - lastMs;
  // A negative elapsed time means the fix is in the future, which is a clock
  // problem, not a projection opportunity.
  if (elapsedMs <= 0 || elapsedMs > config.maximumHorizonMs) return null;

  const distanceMetres = speedKnots * KNOTS_TO_METRES_PER_SECOND * (elapsedMs / 1000);
  const projected = projectPosition(position, courseDegrees, distanceMetres);

  return {
    position: projected,
    projected: true,
    projected_from: position,
    projected_metres: Math.round(distanceMetres),
    projected_elapsed_ms: elapsedMs,
    uncertainty_metres: Math.round(
      Math.max(distanceMetres * config.uncertaintyFraction, config.minimumUncertaintyMetres)
    ),
  };
}

// Measure how wrong dead reckoning actually is, against real observed tracks.
//
// For each point in a track, project from the PREVIOUS point forward to that
// point's timestamp, and compare with where the vessel actually turned out to
// be. That yields a real error distribution rather than a claim.
//
// This is what lets the projection be described with a number. Run it over
// recorded tracks; do not quote a figure that did not come out of it.
export function measureProjectionError(track, options = {}) {
  const points = (track?.points || []).filter(
    (p) => Number.isFinite(p.timestamp_ms) && Array.isArray(p.position)
  );
  const errors = [];

  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const actual = points[i];
    const projection = projectContact(
      {
        position: from.position,
        last_report_ms: from.timestamp_ms,
        speed_over_ground_knots: from.speed_over_ground_knots,
        course_over_ground_degrees: from.course_over_ground_degrees,
      },
      actual.timestamp_ms,
      options
    );
    if (!projection) continue;

    errors.push({
      elapsed_ms: actual.timestamp_ms - from.timestamp_ms,
      // How far the projection landed from the truth.
      error_metres: haversineMetres(projection.position, actual.position),
      // How far the contact actually moved. Error as a fraction of this is the
      // number that matters: 50m of error on a 2km run is good, on a 60m run
      // it is useless.
      travelled_metres: haversineMetres(from.position, actual.position),
    });
  }

  if (errors.length === 0) {
    return { samples: 0, median_error_metres: null, p90_error_metres: null, median_error_fraction: null };
  }

  const sortedError = errors.map((e) => e.error_metres).sort((a, b) => a - b);
  const fractions = errors
    .filter((e) => e.travelled_metres > 1)
    .map((e) => e.error_metres / e.travelled_metres)
    .sort((a, b) => a - b);
  const at = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : null);

  return {
    samples: errors.length,
    median_error_metres: Math.round(at(sortedError, 0.5)),
    p90_error_metres: Math.round(at(sortedError, 0.9)),
    max_error_metres: Math.round(sortedError.at(-1)),
    median_error_fraction: fractions.length ? Number(at(fractions, 0.5).toFixed(3)) : null,
    median_elapsed_ms: Math.round(
      errors.map((e) => e.elapsed_ms).sort((a, b) => a - b)[Math.floor(errors.length / 2)]
    ),
  };
}
