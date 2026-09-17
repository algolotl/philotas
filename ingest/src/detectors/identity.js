// Identity anomaly detector — signals that "this MMSI" is not a coherent
// single identity.
//
// Two independent checks, because they catch different failures. A malformed
// MMSI means the transmitter was never configured correctly, or is spoofing a
// syntactically-invalid number: 9 digits, first three a real maritime
// identification digit range (201-775 per ITU-R M.585). The same MMSI
// reporting two different names over time means either a reflagging that was
// never re-registered, or two vessels colliding on one MMSI. Both matter to
// an operator; neither needs a model.

const MMSI_PATTERN = /^\d{9}$/;
const MIN_VALID_MID = 201;
const MAX_VALID_MID = 775;

// Case/whitespace-normalised so re-formatting the same name ("Sea Horse" vs
// "SEA   HORSE") is not mistaken for a real identity change.
function normalizeName(name) {
  return typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').toUpperCase() : null;
}

function checkMmsiFormat(mmsi) {
  const value = String(mmsi ?? '');
  if (!MMSI_PATTERN.test(value)) return `MMSI "${value}" is not 9 digits`;
  const mid = Number(value.slice(0, 3));
  if (mid < MIN_VALID_MID || mid > MAX_VALID_MID) {
    return `MMSI "${value}" has MID ${value.slice(0, 3)}, outside the valid 201-775 maritime country-code range`;
  }
  return null;
}

// Distinct names seen for this MMSI up to `now`, first-spelling-wins per
// normalised form.
function checkNameHistory(observedNames, now) {
  const visible = (observedNames || []).filter((entry) => entry.timestamp_ms <= now);
  const seen = new Map(); // normalized -> original entry
  for (const entry of visible) {
    const normalized = normalizeName(entry.name);
    if (!normalized) continue;
    if (!seen.has(normalized)) seen.set(normalized, entry);
  }
  if (seen.size < 2) return null;
  const names = [...seen.values()].map((entry) => `"${entry.name}"`).join(', ');
  return `reported ${seen.size} different names over time: ${names}`;
}

export function detectIdentityAnomaly(track, now, options = {}) {
  const reasons = [];

  const formatIssue = checkMmsiFormat(track.mmsi);
  if (formatIssue) reasons.push(formatIssue);

  const nameIssue = checkNameHistory(options.observedNames, now);
  if (nameIssue) reasons.push(nameIssue);

  if (reasons.length === 0) return null;

  // No lookahead: only a visible position, if any, is attached to the event.
  const visible = (track.points || []).filter((point) => point.timestamp_ms <= now);
  const last = visible.at(-1) || null;

  return {
    type: 'identity_anomaly',
    mmsi: track.mmsi,
    vessel_name: track.name || null,
    // Same stability contract as the other detectors: a fresh `now` every 30 s
    // pass would make recordEvent's `${type}:${mmsi}:${started_at_ms}` id change
    // on every pass and fill the events table with duplicates of one anomaly.
    // The malformed-format half is inherent to the identity (the MMSI itself is
    // the trigger), so its start is the first time it became visible.
    started_at_ms: (visible[0] || {}).timestamp_ms ?? now,
    detected_at_ms: now,
    position: last ? last.position : null,
    invalid_mmsi_format: Boolean(formatIssue),
    name_inconsistency: Boolean(nameIssue),
    evidence: reasons.join('; '),
  };
}
