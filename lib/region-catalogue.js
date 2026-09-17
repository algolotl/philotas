// The 64 probed candidates, turned into regions.
//
// The geography and the measurements come from lib/data/region-probe.js and are
// not restated here. What this file adds is the map-view treatment — how wide
// the default box is and how far in the camera opens — and the coverage verdict,
// which is DERIVED from the readings on every build rather than stored. A stored
// verdict can drift from its evidence; a derived one cannot, and twice already
// it would have: run 1 read ningbo at 0 aircraft and run 2 read 1, then run 2
// read kuwait at 0 and run 3 read 1. Either single-run answer, written down,
// would have told an operator that a working port has no aircraft over it.
//
// New regions get the six globally-capable layers and nothing else. Transport,
// vessels, berths, cameras and facilities each need a national data agreement and
// stay Sydney-only. Counted 2026-08-17 off the built regions: 6 layers here
// against Sydney's 12, the difference being vessels, berths, transport, cameras,
// fires, weather and facilities. These are thinner pictures than the flagship
// and the interface should not imply otherwise.
//
// How much thinner, on the one layer anybody actually measured: the probe read
// 0 to 563 aircraft within 150 nm across the 64 candidates on run 2 (median 39)
// and 0 to 433 on run 3 (median 46), computed from lib/data/region-probe.js.
// Per-region totals across all six layers were never measured, so no figure for
// those is quoted here.
//
// These cost nothing while nobody is looking at them. lib/cache.js reaps a
// non-warm region's pollers after five minutes idle and the warm set is
// configured, not inferred — `PARALLAX_WARM_REGIONS` defaults to `sydney` alone
// and nothing here touches it. That is what makes 64 cold regions free rather
// than 64 times the load on a volunteer feeder network. News costs nothing
// either: one bulk GKG file every fifteen minutes covers the world and every
// region filters the same window out of it.
//
// That default is the whole basis of the paragraph above, so it is asserted
// rather than described: test/warm-regions-default.test.js runs with
// PARALLAX_WARM_REGIONS unset and pins `_warmRegions()` to `['sydney']`, and
// pins the 20 s aviation TTL beside it, since the daily spend is the product of
// the two. One warm region at 20 s is 4,320 adsb.fi calls a day; all 83 would be
// 358,560.

// The two acyclic imports come FIRST, deliberately. Import order is evaluation
// order, so if lib/regions.js were listed first and something imported this
// module before that one, regions.js would run its whole body — including the
// REGIONS literal, including the call below — while lib/data/region-probe.js was
// still unevaluated and `CANDIDATES` still in the dead zone. Measured: that is
// exactly what happened, and it threw
// `ReferenceError: Cannot access 'CANDIDATES' before initialization`.
import { CANDIDATES } from './data/region-probe.js';
import { classifyAdsbCoverage } from './adsb-coverage.js';
import { place } from './regions.js';

// A function, and specifically a hoisted `function` declaration, because this
// module and lib/regions.js import each other.
//
// The plan called for `export const CATALOGUE_REGIONS = Object.fromEntries(...)`
// on the grounds that `place` is hoisted and so is ready by the time the
// catalogue runs. `place` is ready. What is not ready is what `place` reads:
// NEWS_CATCHMENT_MULTIPLE and clampLatitude are `const` in lib/regions.js, and
// under a cycle the imported module's body runs first, so both are still in the
// temporal dead zone. An eager version throws
// `ReferenceError: Cannot access 'NEWS_CATCHMENT_MULTIPLE' before initialization`
// at import, which is what it did on the first run of this task.
//
// Nor is that fixable by reordering. Whichever of the two modules is entered
// first, one of them evaluates a top-level `const` the other needs: entering
// lib/regions.js puts this file's body ahead of the consts it depends on, and
// entering this file puts the REGIONS literal ahead of CATALOGUE_REGIONS.
// Deferring the work into a function call sidesteps both — nothing here runs
// until lib/regions.js's object literal calls it, by which point every const in
// that file is initialised. Verified from both entry points.
//
// So: not `const buildCatalogueRegions = () => ...`. A const arrow would restore
// exactly the dead-zone hazard this exists to avoid, in the direction where this
// module is entered first.
export function buildCatalogueRegions() {
  // A metro-sized box for a port city, and a corridor for a chokepoint.
  //
  // A design choice, not a measurement. A strait's traffic is spread along tens
  // of nautical miles of water rather than clustered on a downtown, so a box
  // sized for a CBD opens on empty sea either side of the shipping lane. The map
  // half-extent doubles and the camera opens one and a half steps further out.
  // The news catchment follows automatically at three times whatever this is —
  // for these two types, and only these two. NEWS_CATCHMENT_TYPES in
  // lib/regions.js names them, because the multiple was scored at metro scale
  // and a continental box does not get it. Worth knowing before adding a row
  // here for either of the two wide types named below.
  //
  // Only the two types the artefact actually carries. `country` and `region` are
  // legal values of REGION_TYPES but no candidate uses them, so adding a row for
  // either would be a view nothing renders — see the throw below for what
  // happens if one arrives.
  //
  // Inside the function rather than at module scope for the same dead-zone
  // reason as everything else here: at module scope it is a `const`, and in the
  // direction where this module is entered first, lib/regions.js's object
  // literal calls this function before that const is initialised. It is built
  // once, on the single call that builds the catalogue.
  const VIEW_BY_TYPE = {
    city: { half: [0.6, 0.5], zoom: 9.5 },
    strait: { half: [1.2, 1.0], zoom: 8 },
  };

  return Object.fromEntries(CANDIDATES.map((candidate) => {
    const view = VIEW_BY_TYPE[candidate.type];
    // test/region-probe-artefact.test.js pins every candidate to `city` or
    // `strait`, so this is unreachable today. It is here because the alternative
    // on the day a third type lands is `Cannot read properties of undefined`
    // thrown from a destructure, which names neither the candidate nor the
    // problem.
    if (!view) {
      throw new Error(
        `candidate ${candidate.id} has type "${candidate.type}", which has no map-view default`,
      );
    }
    return [candidate.id, place({
      id: candidate.id,
      name: candidate.name,
      type: candidate.type,
      // A strait has no country, and the artefact records that as null. place()
      // writes the field through untouched, so passing null would put
      // `country: null` on the region where every other unset field is absent;
      // undefined keeps the shape uniform and REGION_LIST normalises back to
      // null for the picker.
      country: candidate.country || undefined,
      theatre: candidate.theatre,
      center: candidate.center,
      half: view.half,
      zoom: view.zoom,
      // Sites are hand-verified geography and none of these has been verified, so
      // none gets any. `place()` defaults to an empty list and the region works
      // without them: the arc targets `home` in every step.
      sites: [],
      // Throws if a candidate has fewer than two readings, which is the intended
      // behaviour — a build that cannot say what a region's coverage is should
      // fail loudly at import rather than quietly publish one run's answer.
      adsbCoverage: classifyAdsbCoverage(candidate.readings),
    })];
  }));
}
