// Course deviation detector — a sustained heading change, not a wobble.
//
// Compares the mean heading of two consecutive windows. Headings are circular,
// so they are averaged as unit vectors: naive arithmetic on degrees makes 359
// and 1 average to 180, which would report a vessel crossing north as a U-turn.

const DEFAULTS = {
  windowSize: 4,
  minimumTurnDegrees: 60,
  // Course over ground is meaningless for a vessel that is barely moving; a
  // drifting hull reports wildly varying headings that look like violent
  // manoeuvring.
  minimumSpeedKnots: 2.0,
};

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

// Circular mean of a set of bearings, in degrees [0, 360).
function meanBearingDegrees(bearings) {
  let sumSin = 0;
  let sumCos = 0;
  for (const bearing of bearings) {
    sumSin += Math.sin(toRadians(bearing));
    sumCos += Math.cos(toRadians(bearing));
  }
  return (toDegrees(Math.atan2(sumSin / bearings.length, sumCos / bearings.length)) + 360) % 360;
}

// Smallest absolute angle between two bearings, in degrees [0, 180].
function angularDifferenceDegrees(first, second) {
  const difference = Math.abs(first - second) % 360;
  return difference > 180 ? 360 - difference : difference;
}

export function detectDeviation(track, now, options = {}) {
  const config = { ...DEFAULTS, ...options };

  // No lookahead.
  const visible = (track.points || []).filter((point) => point.timestamp_ms <= now);
  if (visible.length < config.windowSize * 2) return null;

  const recent = visible.slice(-config.windowSize);
  const previous = visible.slice(-config.windowSize * 2, -config.windowSize);

  // The turn is only meaningful against a coherent previous heading. A vessel
  // at rest (or barely moving) reports noise COG — 0° while it swings on its
  // mooring — so a departure from standstill would otherwise read as a violent
  // U-turn against that noise. Speed is checked across BOTH windows, not just
  // the recent one: the minimum-speed gate exists to suppress exactly this.
  const slowestKnots = Math.min(
    ...recent.map((point) => point.speed_over_ground_knots ?? 0),
    ...previous.map((point) => point.speed_over_ground_knots ?? 0)
  );
  if (slowestKnots < config.minimumSpeedKnots) return null;

  const previousBearing = meanBearingDegrees(
    previous.map((point) => point.course_over_ground_degrees ?? 0)
  );
  const recentBearing = meanBearingDegrees(
    recent.map((point) => point.course_over_ground_degrees ?? 0)
  );
  const turnDegrees = angularDifferenceDegrees(previousBearing, recentBearing);
  if (turnDegrees < config.minimumTurnDegrees) return null;

  return {
    type: 'course_deviation',
    mmsi: track.mmsi,
    vessel_name: track.name || null,
    // The start of the deviation is the oldest report in the window that
    // first established the turn, not "now": recordEvent's dedup id is
    // `${type}:${mmsi}:${started_at_ms}`, and a detector that stamps a fresh
    // `now` every 30 s pass would write a new row each time instead of
    // updating the one already open for this turn.
    started_at_ms: previous[0].timestamp_ms,
    detected_at_ms: now,
    position: recent.at(-1).position,
    previous_course_degrees: Math.round(previousBearing),
    current_course_degrees: Math.round(recentBearing),
    turn_degrees: Math.round(turnDegrees),
    sustained_over_reports: config.windowSize,
    evidence:
      `turned ${Math.round(turnDegrees)}° from ${Math.round(previousBearing)}° to ` +
      `${Math.round(recentBearing)}°, sustained over ${config.windowSize} reports at ` +
      `${slowestKnots.toFixed(1)}kn or better`,
  };
}
