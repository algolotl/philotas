import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// See test/poller-reaping.test.js:11-19 — lib/regions.js reaches a JSON module
// with no import attribute through lib/config.js.
//
// The shim has to be registered before the first `await import` below, which is
// why the probe artefact and the classifier are imported after it even though
// neither reaches any JSON itself.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

const { REGIONS, REGION_LIST, THEATRES, REGION_TYPES, place } = await import('../lib/regions.js');
const { CANDIDATES } = await import('../lib/data/region-probe.js');
const { classifyAdsbCoverage } = await import('../lib/adsb-coverage.js');

const ALL = Object.values(REGIONS);
// Derived from the exported REGION_TYPES rather than a second hand-written
// list, so the type vocabulary has exactly one definition (lib/regions.js)
// instead of drifting between production code and this test.
const PERMITTED_TYPES = new Set(REGION_TYPES);

test('the seven theatres are exactly the ones the design names, in picker order, and frozen', () => {
  // A sorted comparison only checks membership. `THEATRES`' order is a stated
  // contract (task-2-brief.md:14, "in picker order") and is load-bearing —
  // lib/regions.js's own comment says Global stays first "where it has always
  // been" — so this compares the array as-declared, not sorted, and reversing
  // or reordering THEATRES must fail here even though every element is still
  // present.
  assert.deepEqual(THEATRES, [
    'Global', 'Australia & NZ', 'United States', 'Europe',
    'Middle East', 'North East Asia', 'South East Asia',
  ]);
  assert.ok(Object.isFrozen(THEATRES),
    'THEATRES must be frozen — the brief specifies it and a mutable picker order can be reordered at runtime');
});

test('every region declares a theatre from the permitted set', () => {
  for (const region of ALL) {
    assert.ok(region.theatre, `${region.id} has no theatre`);
    assert.ok(THEATRES.includes(region.theatre),
      `${region.id} has theatre "${region.theatre}", which is not one of the seven`);
  }
});

test('every region declares a permitted type', () => {
  for (const region of ALL) {
    assert.ok(PERMITTED_TYPES.has(region.type), `${region.id} has type "${region.type}"`);
  }
});

test('every region id matches its key in REGIONS', () => {
  for (const [key, region] of Object.entries(REGIONS)) {
    assert.equal(region.id, key, `REGIONS.${key} carries id "${region.id}"`);
  }
});

test('REGION_LIST carries the theatre for every region', () => {
  assert.equal(REGION_LIST.length, ALL.length);
  for (const entry of REGION_LIST) {
    assert.ok(THEATRES.includes(entry.theatre),
      `REGION_LIST entry ${entry.id} has theatre "${entry.theatre}"`);
    assert.equal(entry.theatre, REGIONS[entry.id].theatre);
  }
});

// A region whose centre sits at the exact midpoint of its own bounding box had
// that box derived FROM the centre by place() (bbox = center +/- half). Checking
// one against the other there compares an output with itself and holds for any
// centre at all, swapped or garbage. A region whose centre is off-midpoint wrote
// its box by hand, and for those the comparison is a real check.
//
// Detected rather than listed, so the set cannot go stale: convert sydney to
// place() and it drops out, add a new hand-authored region and it joins.
// Measured 2026-08-17 across all 83 regions — sydney (centre 0.178 deg off its
// box's midpoint in longitude) and canberra (0.1756 / 0.1919) are the only two.
const CENTRE_MIDPOINT_TOLERANCE = 1e-9;
const hasIndependentlyAuthoredBbox = (region) => Boolean(region.bbox) && (
  Math.abs((region.bbox.west + region.bbox.east) / 2 - region.center[0]) > CENTRE_MIDPOINT_TOLERANCE ||
  Math.abs((region.bbox.south + region.bbox.north) / 2 - region.center[1]) > CENTRE_MIDPOINT_TOLERANCE
);

test('every hand-authored bounding box contains its own centre', () => {
  // Scoped to the hand-authored boxes because that is the only population where
  // this assertion can fail. It used to run over all 83 and was reported as a
  // guard against a swapped lon/lat pair; it never was one for the 80 regions
  // place() builds, and this task grew that population from 17 to 80. Measured:
  // a candidate centre set to [999, -999], and a transposed candidate centre,
  // both leave the old whole-set version green.
  //
  // What actually covers a wrong centre, both verified by mutation:
  //   * introduced by this file's own catalogue wiring — 'each region keeps the
  //     centre, name, theatre, country and type the probe recorded' below,
  //     which deep-equals every one of the 64 against the probe artefact and
  //     kills both a transposition and [999, -999];
  //   * present in the probe artefact itself — the theatre-envelope geometry in
  //     test/region-probe-artefact.test.js, which covers all 64 and kills a
  //     transposition, a move to another theatre, and a 3-degree nudge.
  // Task 2 filed the gap as Important I1 and deferred the fix to "a later task";
  // that task has shipped, and this is where it landed.
  const handAuthored = ALL.filter(hasIndependentlyAuthoredBbox);

  // Without this the narrowing above could quietly select nothing — every region
  // becoming place()-built would empty the loop and leave the test reporting
  // success having asserted the same nothing it used to.
  assert.ok(handAuthored.length >= 2,
    `only ${handAuthored.length} regions author a bounding box independently of their centre; ` +
    'expected at least sydney and canberra');
  const ids = handAuthored.map((region) => region.id);
  for (const id of ['sydney', 'canberra']) {
    assert.ok(ids.includes(id),
      `${id} no longer authors its own bounding box, so nothing checks its centre against it`);
  }

  for (const region of handAuthored) {
    const [lon, lat] = region.center;
    assert.ok(lon >= region.bbox.west && lon <= region.bbox.east,
      `${region.id} centre longitude ${lon} is outside ${region.bbox.west}..${region.bbox.east}`);
    assert.ok(lat >= region.bbox.south && lat <= region.bbox.north,
      `${region.id} centre latitude ${lat} is outside ${region.bbox.south}..${region.bbox.north}`);
  }
});

test('every region centre is a valid coordinate', () => {
  for (const region of ALL) {
    const [lon, lat] = region.center;
    assert.ok(lon >= -180 && lon <= 180, `${region.id} longitude ${lon}`);
    assert.ok(lat >= -90 && lat <= 90, `${region.id} latitude ${lat}`);
  }
});

// Checks a single coverage record against the shape Task 2 defines: a verdict
// that never travels without at least two readings behind it.
function assertCoverageRecordIsSound(id, coverage, today) {
  assert.equal(typeof coverage, 'object',
    `${id} coverage is ${typeof coverage} — a bare boolean is a verdict with no evidence`);
  assert.ok(['blind', 'unmeasured', 'covered'].includes(coverage.state),
    `${id} coverage state "${coverage.state}"`);
  assert.ok(Array.isArray(coverage.readings) && coverage.readings.length >= 2,
    `${id} coverage rests on ${coverage.readings?.length ?? 0} reading(s) — one run is not a measurement`);
  for (const reading of coverage.readings) {
    assert.ok(reading.run, `${id} has a reading with no run id`);
    assert.match(reading.probedAt, /^\d{4}-\d{2}-\d{2}/,
      `${id} reading from ${reading.run} has probedAt "${reading.probedAt}"`);
    assert.ok(reading.probedAt.slice(0, 10) <= today,
      `${id} claims a reading from ${reading.probedAt}, which is in the future`);
    assert.ok(Number.isInteger(reading.aircraft) && reading.aircraft >= 0,
      `${id} reading from ${reading.run} has aircraft ${reading.aircraft}`);
  }
}

test('every coverage record carries the readings its verdict came from', () => {
  const today = new Date().toISOString().slice(0, 10);

  // None of the 19 regions Task 2 touches carry adsbCoverage yet — the brief
  // (task-2-brief.md) is explicit that the record is "attached to no region
  // yet; Task 6 fills it from the artefact." Looping over REGIONS alone would
  // therefore make this test check nothing at all today: every region hits
  // `coverage === undefined` and the loop body never runs, the same
  // continue-past-everything shape flagged as I1 in Task 1's review. A probe
  // built through place() — the same technique region-news-catchment.test.js
  // uses for clampLatitude's unexercised south branch — exercises the schema
  // now, so a regression in place()'s coverage-writing path (or in the schema
  // itself) fails this test today rather than waiting on Task 6 to give it
  // something to check.
  const covered = place({
    id: 'coverage-schema-probe', name: 'CoverageSchemaProbe', theatre: 'Europe',
    center: [10, 20],
    adsbCoverage: {
      state: 'covered',
      readings: [
        { run: 'run1', probedAt: '2026-08-15', aircraft: 40 },
        { run: 'run2', probedAt: '2026-08-16', aircraft: 42 },
      ],
    },
  });

  // Asserted unconditionally, outside the loop below, rather than folded into
  // it behind a `checked` counter: the probe is a fixture, never legitimately
  // absent, so there is no reason to let its check share the same
  // `continue`-gated path as the shipped regions. That gate is what made the
  // brief's test vacuous in the first place; the probe's soundness should not
  // depend on surviving it too.
  assert.ok(covered.params?.aviation?.coverage, 'place() dropped adsbCoverage entirely');
  assertCoverageRecordIsSound(covered.id, covered.params.aviation.coverage, today);

  // The shipped regions are checked separately. Until the catalogue landed this
  // loop ran over zero of them, and the note here deferred an exact-count
  // assertion to Task 6. Task 6 has landed, so the count is asserted below:
  // every catalogue region carries a coverage record and none of the 19
  // hand-written or hand-placed regions does, because none of them was probed.
  let withCoverage = 0;
  for (const region of ALL) {
    const coverage = region.params?.aviation?.coverage;
    if (coverage === undefined) continue;
    withCoverage++;
    assertCoverageRecordIsSound(region.id, coverage, today);
  }
  assert.equal(withCoverage, CANDIDATES.length,
    `${withCoverage} regions carry a coverage record, expected ${CANDIDATES.length} — ` +
    'either a probed region lost its record, or a region nobody probed acquired one');
});

test('every region carries aviation, satellites, seismic and news', () => {
  // Four, not six. `hotspots` needs a bounding box so `world` has none, and
  // `events` is not on the two hand-written city builds. These four are the ones
  // every region in the build has always carried.
  for (const region of ALL) {
    for (const layer of ['aviation', 'satellites', 'seismic', 'news']) {
      assert.ok(region.layers.includes(layer), `${region.id} is missing the ${layer} layer`);
    }
  }
});

// ---------------------------------------------------------------------------
// The probed coverage expansion. 64 candidates become 64 regions through
// lib/region-catalogue.js.

// Measured at 2520f5f, before the catalogue was spread in, by:
//   node -e "...import('./lib/regions.js'); Object.keys(REGIONS).length"
// which printed 19. test/region-probe-artefact.test.js pins the same 19 by name
// in 'no candidate collides with a region that already exists', so a candidate
// taking over a hand-written key fails there rather than quietly here.
const PRE_EXPANSION_REGION_COUNT = 19;

test('every candidate became exactly one region', () => {
  // Object keys collapse silently on a duplicate, so counting REGIONS against an
  // independently counted source is the only way a duplicated row shows up. The
  // per-candidate loop below does not substitute for it: two candidates mapped
  // onto one key leave both lookups satisfied and the count one short.
  assert.equal(
    Object.keys(REGIONS).length,
    PRE_EXPANSION_REGION_COUNT + CANDIDATES.length,
    'a candidate id duplicated another key and one region was silently overwritten',
  );
  for (const candidate of CANDIDATES) {
    assert.ok(REGIONS[candidate.id], `candidate ${candidate.id} did not become a region`);
  }
});

test('each region keeps the centre, name, theatre, country and type the probe recorded', () => {
  for (const candidate of CANDIDATES) {
    const region = REGIONS[candidate.id];
    assert.deepEqual(region.center, candidate.center, `${candidate.id} centre drifted from the probe`);
    assert.equal(region.name, candidate.name);
    assert.equal(region.theatre, candidate.theatre);
    // A strait carries no country, and place() leaves the field `undefined`
    // rather than null. REGION_LIST normalises it to null for the picker; this
    // compares against the artefact's own null.
    assert.equal(region.country ?? null, candidate.country);
    assert.equal(region.type, candidate.type);
  }
});

test('every coverage verdict is the one the classifier derives from the readings', () => {
  // Not a copy of the artefact and not hand-entered: recomputed here from the
  // readings and compared. A verdict typed in by hand cannot survive this.
  //
  // Twice now a stored single-run verdict would have published a false claim
  // about a working port. Run 1 read ningbo at zero and run 2 read 1; run 2 read
  // kuwait at zero and run 3 read 1. Deriving on every build is what makes an
  // appended run change the answer instead of leaving it stale.
  for (const candidate of CANDIDATES) {
    const expected = classifyAdsbCoverage(candidate.readings);
    const actual = REGIONS[candidate.id].params.aviation.coverage;
    assert.equal(actual.state, expected.state, `${candidate.id} coverage state`);
    assert.deepEqual(actual.readings, candidate.readings, `${candidate.id} coverage readings`);
  }
});

test('the coverage states partition the catalogue the way the recorded runs do', () => {
  // FOUR blind, not five. The design spec and the task brief both name five and
  // include kuwait, and run 3 refuted that: kuwait reads 0, 0, 1 and shanghai
  // reads 5, 5, 0, so both are `unmeasured` now. Recomputed from the artefact on
  // 2026-08-17 — blind 4, unmeasured 4, covered 56 of 64. If a fourth run lands
  // and moves one of these, the run is right and this list is what gets edited.
  const idsInState = (state) => Object.values(REGIONS)
    .filter((region) => region.params?.aviation?.coverage?.state === state)
    .map((region) => region.id).sort();

  assert.deepEqual(idsInState('blind'), ['babelmandeb', 'guam', 'jeddah', 'vladivostok'],
    'blind means every recorded run read zero — kuwait read 1 on run 3 and is unmeasured');
  assert.deepEqual(idsInState('unmeasured'), ['kuwait', 'ningbo', 'odesa', 'shanghai'],
    'unmeasured means the runs disagree about whether anything is there at all');
  // Counted rather than listed: 56 names would be a transcription of the
  // artefact, and the two sets above already pin every region whose verdict is
  // not "something was found on every run".
  assert.equal(idsInState('covered').length, CANDIDATES.length - 8);
});

test('no new region claims a national-integration layer', () => {
  // Transport, berths, cameras and facilities each need a national data
  // agreement. Sydney is the worked example; canberra keeps facilities and the
  // Deep Space Network because Tidbinbilla is genuinely there. Nothing built from
  // the catalogue may imply otherwise: counted 2026-08-17, a catalogue region
  // carried 6 layers against Sydney's 12.
  //
  // `vessels` left this list on 2026-09-19. It was here because every vessel
  // source the project had was a national agreement; the layer then gained a
  // keyless worldwide AIS feed (lib/feeds/openwaters-ais.js), which makes it
  // global in the same way `hotspots` is. What this list defends is the claim a
  // region makes, so the layer moves out of it rather than the list being
  // dropped.
  const NATIONAL = ['transport', 'berths', 'cameras', 'facilities', 'space'];
  for (const candidate of CANDIDATES) {
    for (const layer of NATIONAL) {
      assert.ok(!REGIONS[candidate.id].layers.includes(layer),
        `${candidate.id} claims the ${layer} layer, which is a national integration`);
    }
  }
});

test('a chokepoint opens on a wider box and a further-out camera than a port city', () => {
  // The per-type view defaults are a design choice, not a measurement, and this
  // is what stops the two collapsing into one. Without it, deleting the `strait`
  // row from VIEW_BY_TYPE would leave every test above green — the centre, the
  // theatre and the coverage all still match — while nine chokepoints silently
  // opened on a box sized for a downtown.
  const straits = CANDIDATES.filter((candidate) => candidate.type === 'strait');
  const cities = CANDIDATES.filter((candidate) => candidate.type === 'city');
  assert.equal(straits.length, 9, 'the artefact carries nine chokepoints');
  assert.equal(cities.length, 55);

  // BOTH components of the half-extent, not just the width. Measured on the
  // first version of this test, which checked width and zoom alone: halving the
  // strait height to [1.2, 0.5], and inflating the metro height to [0.6, 5.0],
  // each survived all 36 tests in this file and its two neighbours. Height is
  // also the component that propagates furthest — NEWS_CATCHMENT_MULTIPLE takes
  // it 3x wider again, so a metro box 10 degrees tall silently becomes a 30
  // degree news catchment and changes which articles the region ever sees.
  const width = (region) => region.bbox.east - region.bbox.west;
  const height = (region) => region.bbox.north - region.bbox.south;
  const near = (actual, expected) => Math.abs(actual - expected) < 1e-9;

  for (const candidate of straits) {
    const region = REGIONS[candidate.id];
    assert.ok(near(width(region), 2.4),
      `${candidate.id} map box is ${width(region)} degrees wide, expected the 2.4 strait corridor`);
    assert.ok(near(height(region), 2.0),
      `${candidate.id} map box is ${height(region)} degrees tall, expected the 2.0 strait corridor`);
    assert.equal(region.zoom, 8, `${candidate.id} opens at zoom ${region.zoom}`);
  }
  for (const candidate of cities) {
    const region = REGIONS[candidate.id];
    assert.ok(near(width(region), 1.2),
      `${candidate.id} map box is ${width(region)} degrees wide, expected the 1.2 metro default`);
    assert.ok(near(height(region), 1.0),
      `${candidate.id} map box is ${height(region)} degrees tall, expected the 1.0 metro default`);
    assert.equal(region.zoom, 9.5, `${candidate.id} opens at zoom ${region.zoom}`);
  }
});

test('every strait carries no sites, no berths, and the global vessel layer', () => {
  const straits = Object.values(REGIONS).filter((r) => r.type === 'strait');
  assert.equal(straits.length, 9, 'the design names nine chokepoints');
  for (const strait of straits) {
    // Honest about what this proves today: no catalogue region has sites at all,
    // so this is a guard on the next edit rather than a check on current data. It
    // fires the moment somebody hangs a port on a waterway.
    assert.deepEqual(strait.sites, [], `${strait.id} has sites`);
    // berths, not vessels. A berth register is a specific port's property and no
    // chokepoint has one — but vessels became a global layer on 2026-09-19 (a
    // keyless worldwide AIS feed), and a strait is exactly where hulls belong.
    // The positive assertion pins that, so deleting the layer again is a failure
    // here rather than a silent thinning of the picture.
    assert.ok(!strait.layers.includes('berths'), `${strait.id} claims the berths layer`);
    assert.ok(strait.layers.includes('vessels'),
      `${strait.id} has no vessels layer, and the global AIS feed is what puts hulls on a chokepoint`);
  }
});

test('a strait opens on a wider box than a port city', () => {
  // Every strait against every city, not `.find()` against `.find()` — the same
  // weakness the arc-copy test below documents. One pair proves the pair, and
  // the pair `.find()` returns is whichever happens to iterate first.
  const width = (r) => r.bbox.east - r.bbox.west;
  const straits = Object.values(REGIONS).filter((r) => r.type === 'strait');
  const cities = Object.values(REGIONS).filter((r) => r.type === 'city');
  assert.equal(straits.length, 9, 'the design names nine chokepoints');
  assert.equal(cities.length, 70, 'and the catalogue carries seventy city views');

  // Measured 2026-08-17 off the built regions: every strait is 2.4 degrees
  // wide, the widest city is canberra at 2.2 (hand-written, the ACT region box)
  // and every place()-built city is 1.2. The narrowest chokepoint is therefore
  // wider than the widest city, so this can be the strong assertion rather than
  // one lucky pair.
  const narrowestStrait = Math.min(...straits.map(width));
  const widestCity = Math.max(...cities.map(width));
  assert.ok(narrowestStrait > widestCity,
    `narrowest chokepoint is ${narrowestStrait} degrees wide against a widest city of ${widestCity}; `
    + 'a chokepoint is a corridor, and a box sized for a CBD opens on empty sea');

  // The probe candidates are the population the strait treatment was written
  // for, so they are checked as a set of their own rather than left to the
  // catalogue-wide figures above.
  const candidateCities = CANDIDATES.filter((c) => c.type === 'city').map((c) => REGIONS[c.id]);
  assert.equal(candidateCities.length, 55, 'the artefact carries fifty-five city candidates');
  for (const city of candidateCities) {
    assert.ok(narrowestStrait > width(city), `${city.id} opens on a box as wide as a chokepoint`);
  }
});

test('a strait is not described as a place people live in', () => {
  // Every strait, not `Object.values(REGIONS).find(...)` for one. The brief's own
  // version picked whichever strait iterates first — taiwanstrait, "Taiwan
  // Strait" — and its PRE-FIX opening ("Open on Taiwan Strait — air, orbit,
  // seismic and news in one frame.") already matches /strait/i because the
  // region's own name contains the word. Measured: 5 of 9 strait names (Taiwan
  // Strait, Strait of Hormuz, Strait of Gibraltar, Dover Strait, Danish Straits)
  // do the same, so a `.find()`-based version passes whether or not the arc copy
  // is type-aware whenever it happens to land on one of those five — it proved
  // nothing about the fix for `isChokepoint` being false. suez, babelmandeb,
  // istanbul and kiel do not carry a trigger word in their own name, which is
  // exactly why looping over all nine, rather than trusting the first match, is
  // the version that can actually fail.
  const straits = Object.values(REGIONS).filter((r) => r.type === 'strait');
  assert.equal(straits.length, 9, 'the design names nine chokepoints');
  for (const strait of straits) {
    const opening = strait.arc[0].body;
    assert.match(opening, /waterway|chokepoint/i,
      `strait arc opens with "${opening}", which reads like a city`);
  }
});
