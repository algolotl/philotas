// In-memory current vessel state, keyed by MMSI.
//
// Deliberately a plain reducer over reports with no I/O: it is what the
// detectors read, so it has to be testable without a socket or a database.
// Durability is the store's job, not this module's.

const DEFAULTS = {
  // Enough history for a cadence baseline and a turn window without unbounded
  // growth. A busy harbour holds a few thousand vessels at once.
  maximumTrackPoints: 200,
  // The identity-anomaly detector only needs to know a name changed, not the
  // full spelling history — a handful of entries is plenty.
  maximumNameHistory: 10,
};

export function createVesselState(options = {}) {
  return {
    config: { ...DEFAULTS, ...options },
    vessels: new Map(), // mmsi -> vessel
    tracks: new Map(), // mmsi -> { mmsi, name, points: [], nameHistory: [] }
  };
}

// Record a distinct name spelling on a track, timestamped, so the
// identity-anomaly detector can tell a reflagged/duplicate MMSI from a vessel
// that has always had one name. Repeats of the same spelling are not
// appended — only an actual change is a signal. Shared by applyReport
// (PositionReport/ShipStaticData frames that carry both position and name)
// and recordObservedName (a ShipStaticData-only identity update).
function appendNameObservation(state, track, name, timestamp_ms) {
  if (!name) return;
  if (!track.nameHistory) track.nameHistory = []; // tracks created before this field existed
  const lastNamed = track.nameHistory.at(-1);
  if (!lastNamed || lastNamed.name !== name) {
    track.nameHistory.push({ name, timestamp_ms });
    if (track.nameHistory.length > state.config.maximumNameHistory) {
      track.nameHistory.splice(0, track.nameHistory.length - state.config.maximumNameHistory);
    }
  }
  track.name = name;
}

// A name observed for an already-known vessel outside of applyReport — e.g. a
// ShipStaticData frame carries identity but no position, so it updates the
// vessel record directly rather than going through applyReport's point-push
// path. Exported so that path can still feed the identity-anomaly detector's
// name history instead of silently bypassing it.
export function recordObservedName(state, mmsi, name, timestamp_ms) {
  const track = state.tracks.get(mmsi);
  if (!track) return; // nothing to attach a name history to yet
  appendNameObservation(state, track, name, timestamp_ms);
}

export function applyReport(state, report) {
  const { mmsi } = report;
  const track = state.tracks.get(mmsi) || { mmsi, name: report.name || null, points: [], nameHistory: [] };

  // Reports arrive out of order on a busy stream. Anything not strictly newer
  // than what we hold is dropped rather than sorted in: a late report cannot
  // change a decision that was already made from a later fix.
  const latest = track.points.at(-1);
  if (latest && report.timestamp_ms <= latest.timestamp_ms) {
    return { vessel: state.vessels.get(mmsi), track };
  }

  track.points.push({
    timestamp_ms: report.timestamp_ms,
    position: report.position,
    speed_over_ground_knots: report.speed_over_ground_knots ?? null,
    course_over_ground_degrees: report.course_over_ground_degrees ?? null,
  });
  if (track.points.length > state.config.maximumTrackPoints) {
    track.points.splice(0, track.points.length - state.config.maximumTrackPoints);
  }
  appendNameObservation(state, track, report.name, report.timestamp_ms);
  state.tracks.set(mmsi, track);

  // Identity fields fall back to what is already known. AIS position reports
  // and static reports are different message types: a position report carries
  // no name or destination, and must not erase one already established.
  const existing = state.vessels.get(mmsi) || { mmsi, first_seen_ms: report.timestamp_ms };
  const vessel = {
    ...existing,
    mmsi,
    name: report.name ?? existing.name ?? null,
    ship_type: report.ship_type ?? existing.ship_type ?? null,
    destination: report.destination ?? existing.destination ?? null,
    position: report.position,
    speed_over_ground_knots: report.speed_over_ground_knots ?? null,
    course_over_ground_degrees: report.course_over_ground_degrees ?? null,
    last_report_ms: report.timestamp_ms,
  };
  state.vessels.set(mmsi, vessel);

  return { vessel, track };
}

export function getTrack(state, mmsi) {
  return state.tracks.get(mmsi) || null;
}

// Timestamped name-spelling history for a vessel, oldest first. Feeds the
// identity-anomaly detector's options.observedNames.
export function getObservedNames(state, mmsi) {
  return state.tracks.get(mmsi)?.nameHistory || [];
}

export function allVessels(state) {
  return [...state.vessels.values()];
}

// Drop vessels not heard from within the window. Returns the count removed.
export function pruneStale(state, now, maxAgeMs) {
  let removed = 0;
  for (const [mmsi, vessel] of state.vessels) {
    if (now - vessel.last_report_ms > maxAgeMs) {
      state.vessels.delete(mmsi);
      state.tracks.delete(mmsi);
      removed += 1;
    }
  }
  return removed;
}
