// What two or more probe runs establish about a region's ADS-B feeder coverage.
//
// Derived from AGREEMENT, never from magnitude, and never from one run.
//
// Why not magnitude: the obvious rule is "below N aircraft is sparse", and the
// runs of 2026-08-16 cannot supply an N. Run 2's 64 counts sorted run 0, 0, 0,
// 0, 0, 1, 1, 3, 4, 5, 7, 8, 8, 9, 10, 11, 11, 13, 14, 17, 24, 24, 25, ... and
// the widest gap anywhere below 55 aircraft is 7, from 17 to 24. A threshold
// placed anywhere in that range separates neighbours differing by one or two
// aircraft, which is less than the run-to-run noise on those same regions —
// qingdao read 1, then 3, then 1. Of the eleven candidates carrying both a run-1
// and a run-2 reading, eight sit below 10 in both, and five of those eight read
// zero in both. So there is no band to fit either.
//
// Why not one run: run 1 read ningbo at 0 aircraft and run 2 read it at 1. A
// build that shipped run 1's answer would have told an operator that a working
// container port has no aircraft over it.
//
// What agreement does support, each with a worked example from the three runs
// recorded in lib/data/region-probe.js:
//   blind      — every run read zero. No volunteer feeder is in range, and
//                independent samples say so. vladivostok: 0, 0, 0.
//   unmeasured — the runs disagree about whether anything is there at all. Not
//                sparse, not covered: unproven, and it says that. shanghai:
//                5, 5, 0.
//   covered    — every run read something. qingdao: 1, 3, 1.
//
// `covered` is not a claim that coverage is GOOD, and qingdao is the case that
// shows it: one, three and one aircraft within 150 nm of a major container port
// is plainly feeder scarcity, and it still classifies as covered because every
// run found something. The layer therefore quotes the readings alongside the
// state (see lib/feeds/aviation.js) so a reader can draw a line this function
// cannot.
//
// These verdicts move as runs are appended, which is the whole reason the
// artefact records runs rather than a verdict. Run 3 took shanghai from covered
// to unmeasured and kuwait from blind to unmeasured, leaving four candidates
// reading zero in every recorded run where runs 1 and 2 alone had shown five.
export function classifyAdsbCoverage(readings) {
  if (!Array.isArray(readings) || readings.length < 2) {
    throw new Error(
      `one run is not a measurement: ${readings?.length ?? 0} reading(s) supplied, at least 2 required`,
    );
  }
  const counts = readings.map((reading) => reading.aircraft);
  // Refuse a reading this function cannot count, rather than guessing at it.
  //
  // The two `=== 0` tests below are the whole classifier, and a reading that is
  // not a number answers neither of them. Measured before this guard existed:
  // `[{ run: 'r1', probedAt: 'x' }, { run: 'r2', aircraft: 0 }]` — a row with no
  // `aircraft` field at all — returned `covered`, because `Math.max(undefined,
  // 0)` is NaN, `NaN === 0` is false both times, and the fallthrough is the most
  // reassuring verdict available. `'0'` as a string returned `blind` for the
  // mirror-image reason. Failing open is exactly backwards for a function whose
  // premise is that one run is not enough evidence: a row it cannot read is less
  // evidence than one run, not more.
  const unreadable = counts.findIndex((count) => !Number.isInteger(count) || count < 0);
  if (unreadable !== -1) {
    throw new Error(
      `a reading with no aircraft count is not a measurement: run `
      + `${JSON.stringify(readings[unreadable]?.run ?? unreadable)} carries `
      + `${JSON.stringify(counts[unreadable])}, expected a non-negative integer`,
    );
  }
  const highest = Math.max(...counts);
  const lowest = Math.min(...counts);
  if (highest === 0) return { state: 'blind', readings };
  if (lowest === 0) return { state: 'unmeasured', readings };
  return { state: 'covered', readings };
}
