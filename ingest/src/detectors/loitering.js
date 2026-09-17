// Loitering detector — sustained near-stationary behaviour in open water.
//
// Stationary at a berth is a vessel doing its job. Stationary in a channel, off
// a cable route, or outside an anchorage is worth an operator's attention. The
// berth list is what separates the two, so it is a required input rather than
// an optional refinement.
//
// The slow run must END at the most recent visible report. A vessel that
// loitered and then got under way again is a past event, not a current
// condition, and reporting it as one would fill the operator's board with
// things that already resolved themselves.

import { haversineMetres } from '../geo.js';

const DEFAULTS = {
  maximumSpeedKnots: 1.0,
  minimumDurationMs: 20 * 60 * 1000,
  // How far the vessel may wander and still count as holding position. Slow but
  // steadily moving is making way, not loitering.
  maximumDriftMetres: 500,
  minimumReports: 3,
};

function insideAnyBerth(position, berths) {
  return (berths || []).some(
    (berth) => haversineMetres(position, berth.position) <= (berth.radius_metres ?? 250)
  );
}

export function detectLoitering(track, now, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const berths = options.berths || [];

  // No lookahead.
  const visible = (track.points || []).filter((point) => point.timestamp_ms <= now);
  if (visible.length < config.minimumReports) return null;

  // Walk backwards while the vessel is slow. The run must be contiguous and
  // must reach the most recent report — see the note above.
  let index = visible.length - 1;
  if ((visible[index].speed_over_ground_knots ?? Infinity) > config.maximumSpeedKnots) return null;
  while (
    index > 0 &&
    (visible[index - 1].speed_over_ground_knots ?? Infinity) <= config.maximumSpeedKnots
  ) {
    index -= 1;
  }

  const run = visible.slice(index);
  if (run.length < config.minimumReports) return null;

  const durationMs = run.at(-1).timestamp_ms - run[0].timestamp_ms;
  if (durationMs < config.minimumDurationMs) return null;

  const anchor = run[0].position;
  const driftMetres = Math.max(...run.map((point) => haversineMetres(anchor, point.position)));
  if (driftMetres > config.maximumDriftMetres) return null;

  const centre = run.at(-1).position;
  if (insideAnyBerth(centre, berths)) return null;

  const meanSpeedKnots =
    run.reduce((total, point) => total + (point.speed_over_ground_knots ?? 0), 0) / run.length;

  return {
    type: 'loitering',
    mmsi: track.mmsi,
    vessel_name: track.name || null,
    detected_at_ms: now,
    started_at_ms: run[0].timestamp_ms,
    duration_ms: durationMs,
    position: centre,
    drift_metres: Math.round(driftMetres),
    mean_speed_knots: Number(meanSpeedKnots.toFixed(2)),
    report_count: run.length,
    evidence:
      `held position for ${Math.round(durationMs / 60000)}min at ` +
      `${meanSpeedKnots.toFixed(1)}kn mean speed, drifting ${Math.round(driftMetres)}m ` +
      `over ${run.length} reports, outside any known berth`,
  };
}
