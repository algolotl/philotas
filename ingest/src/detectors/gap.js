// AIS transmission gap detector — the "dark vessel" signal.
//
// A vessel that has been reporting on a regular cadence stops. The threshold is
// derived from that vessel's OWN observed cadence, never a global constant: a
// ferry reports every few seconds and an anchored bulk carrier every few
// minutes, so one fixed number either drowns the operator in false positives or
// misses everything.
//
// Deterministic and explainable. The event carries the numbers that produced
// it, because "stopped for 47min against a 90s observed median" is defensible
// in a way that "the AI flagged this vessel" is not.

import { projectPosition, medianIntervalMs } from '../geo.js';

const KNOTS_TO_METRES_PER_SECOND = 0.514444;

const DEFAULTS = {
  // Silence must exceed this multiple of the vessel's own median interval.
  thresholdFactor: 6,
  // ...but never fire below this floor, or dense reporters alarm constantly.
  floorMs: 5 * 60 * 1000,
  // Minimum reports before a baseline means anything.
  minimumPointsForBaseline: 4,
  // The projected position is a guess. Its radius grows as a fraction of the
  // distance travelled since the last fix, plus a floor for immediate error.
  uncertaintyFraction: 0.35,
  minimumRadiusMetres: 200,
};

export function detectGap(track, now, options = {}) {
  const config = { ...DEFAULTS, ...options };

  // No lookahead: only points at or before `now` are visible. A detector that
  // reads later points is leakage and would make itself look better than it is.
  const visible = (track.points || []).filter((point) => point.timestamp_ms <= now);
  if (visible.length < config.minimumPointsForBaseline) return null;

  const baselineIntervalMs = medianIntervalMs(visible.map((point) => point.timestamp_ms));
  if (!baselineIntervalMs) return null;

  const last = visible.at(-1);
  const elapsedMs = now - last.timestamp_ms;
  const thresholdMs = Math.max(baselineIntervalMs * config.thresholdFactor, config.floorMs);
  if (elapsedMs <= thresholdMs) return null;

  const elapsedSeconds = elapsedMs / 1000;
  const distanceMetres =
    (last.speed_over_ground_knots || 0) * KNOTS_TO_METRES_PER_SECOND * elapsedSeconds;
  const projected = projectPosition(
    last.position,
    last.course_over_ground_degrees || 0,
    distanceMetres
  );

  return {
    type: 'ais_gap',
    mmsi: track.mmsi,
    vessel_name: track.name || null,
    detected_at_ms: now,
    elapsed_ms: elapsedMs,
    baseline_interval_ms: baselineIntervalMs,
    threshold_ms: thresholdMs,
    last_report_ms: last.timestamp_ms,
    last_position: last.position,
    last_course_degrees: last.course_over_ground_degrees ?? null,
    last_speed_knots: last.speed_over_ground_knots ?? null,
    projected_position: projected,
    projected_radius_metres: Math.max(
      distanceMetres * config.uncertaintyFraction,
      config.minimumRadiusMetres
    ),
    evidence:
      `stopped reporting for ${Math.round(elapsedMs / 60000)}min against a ` +
      `${Math.round(baselineIntervalMs / 1000)}s observed median over ${visible.length} reports`,
  };
}
