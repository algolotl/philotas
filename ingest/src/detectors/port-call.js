// Port-call mismatch detector — the AIS-declared destination against the
// berth the vessel is actually alongside.
//
// AIS destination is free text a crew member typed, not a controlled
// vocabulary: "PORT BOTANY", "AU PBY", "SYDNEY", "SYDNEY>MELBOURNE", trailing
// junk. A naive string compare against the berth name would misfire on
// nearly every real report — "SYDNEY" is not wrong about a vessel alongside
// ANY Sydney berth, it is just unspecific, and some real berth names (e.g.
// "Sydney Outer Anchorage") contain the word "SYDNEY" themselves, which would
// make a naive substring match false-positive on exactly the input it should
// treat as fine.
//
// This only fires on a CONFIDENT mismatch: the destination has to resolve to
// a place this detector can name, and that place has to be a different one
// than where the vessel is. "Can name it" is deliberately narrow — either the
// destination names another berth from the SAME list passed in (the
// strongest evidence, since it needs no external gazetteer), or it resolves
// to a small curated set of AU ports known to be outside this berth list
// entirely. Anything else falls through to null rather than guessing.

import { haversineMetres } from '../geo.js';

// A vessel typing just the city name is not wrong about being at any berth in
// that city — it is unspecific. Treated as always-consistent so it can never
// trigger a mismatch, even against a berth whose own name contains the word.
const GENERIC_PORT_ALIASES = new Set(['SYDNEY', 'PORT OF SYDNEY', 'SYD']);

// Short codes crews actually type. Deliberately small and curated rather than
// a full UN/LOCODE table: an unrecognised code is meant to fall through to
// null, not get force-fit onto the nearest guess.
const ABBREVIATIONS = {
  CQ: 'CIRCULAR QUAY',
  OPT: 'OVERSEAS PASSENGER TERMINAL',
  PBY: 'PORT BOTANY',
};

// Real ports outside this build's berth list. Small and explicit on purpose:
// a destination resolving to one of these is confidently NOT any berth this
// service knows about, without needing a general-purpose gazetteer.
const KNOWN_ELSEWHERE = new Set([
  'MELBOURNE', 'BRISBANE', 'NEWCASTLE', 'FREMANTLE', 'ADELAIDE', 'HOBART',
  'DARWIN', 'PORT KEMBLA', 'GLADSTONE',
]);

// Words that describe the TYPE of a berth rather than naming the place, so
// they should not count toward a match ("Wharf 2" vs "Terminal 1" both
// carrying "WHARF"/"TERMINAL" would otherwise blur berths together).
const STOP_WORDS = new Set(['WHARF', 'TERMINAL', 'BERTH']);

function stripPunctuation(text) {
  return text.replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(text) {
  return stripPunctuation(text.toUpperCase()).split(' ').filter(Boolean);
}

// AIS multi-leg destinations use '>' (sometimes ';') for "here, then on to".
// Only the first leg is a claim about where the vessel is headed now.
function firstLeg(raw) {
  return raw.split(/[>;]/)[0];
}

// Free text -> the best-effort normalised place name, or null if there is no
// usable string at all. "Unresolvable" beyond that is expressed downstream by
// matching nothing, not here.
function normalizeDestination(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = stripPunctuation(firstLeg(raw).toUpperCase());
  if (!cleaned) return null;
  if (GENERIC_PORT_ALIASES.has(cleaned)) return { generic: true, text: cleaned };

  // "AU PBY" / "AUPBY" — a bare country-code prefix on a code we recognise.
  const withoutCountryPrefix = cleaned.replace(/^AU\s?/, '');
  const expanded = ABBREVIATIONS[cleaned] || ABBREVIATIONS[withoutCountryPrefix];
  if (expanded) return { generic: false, text: expanded };
  if (GENERIC_PORT_ALIASES.has(withoutCountryPrefix)) return { generic: true, text: withoutCountryPrefix };

  return { generic: false, text: cleaned };
}

function berthNameTokens(berth) {
  return tokens(berth.name || '').filter((word) => !STOP_WORDS.has(word));
}

// True when every token of `needle` appears among `haystack` — "PORT BOTANY"
// is inside "PORT BOTANY PATRICK", but not the reverse.
function tokensSubsetOf(needle, haystack) {
  if (needle.length === 0) return false;
  const haystackSet = new Set(haystack);
  return needle.every((word) => haystackSet.has(word));
}

function berthAlongside(position, berths) {
  return (
    (berths || []).find(
      (berth) => haversineMetres(position, berth.position) <= (berth.radius_metres ?? 250)
    ) || null
  );
}

export function detectPortCallMismatch(track, now, options = {}) {
  const berths = options.berths || [];

  // No lookahead: only points at or before `now` are visible.
  const visible = (track.points || []).filter((point) => point.timestamp_ms <= now);
  if (visible.length === 0) return null;
  const last = visible.at(-1);

  const alongside = berthAlongside(last.position, berths);
  if (!alongside) return null; // not currently at a berth — nothing to check against

  const declared = normalizeDestination(options.destination);
  if (!declared || declared.generic) return null; // no usable, specific destination

  const declaredTokens = tokens(declared.text);
  if (tokensSubsetOf(declaredTokens, berthNameTokens(alongside))) return null; // agrees with where it is

  const namesAnotherBerth = berths.some(
    (berth) => berth !== alongside && tokensSubsetOf(declaredTokens, berthNameTokens(berth))
  );
  const namesElsewhere = KNOWN_ELSEWHERE.has(declared.text);
  if (!namesAnotherBerth && !namesElsewhere) return null; // not confident enough to guess

  return {
    type: 'port_call_mismatch',
    mmsi: track.mmsi,
    vessel_name: track.name || null,
    // Stable across passes while the mismatch persists, so recordEvent's
    // `${type}:${mmsi}:${started_at_ms}` id updates the open event instead of
    // writing a fresh row every 30 s.
    started_at_ms: visible[0].timestamp_ms,
    detected_at_ms: now,
    position: last.position,
    berth_id: alongside.id,
    berth_name: alongside.name,
    declared_destination: options.destination,
    matched_destination: declared.text,
    evidence:
      `declared destination "${options.destination}" normalises to "${declared.text}", but the vessel is ` +
      `alongside ${alongside.name}, which does not match that destination`,
  };
}
