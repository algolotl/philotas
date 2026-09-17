import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANDIDATES, RUNS } from '../lib/data/region-probe.js';

// Figures below come from:
//   run 1 — aggregates quoted in docs/superpowers/specs/2026-08-16-coverage-expansion-design.md
//   run 2 — docs/measurements/2026-08-16-region-coverage-probe-run2.txt
// The data comes from the runs. Independent sources, which is the point: this
// catches an artefact reconstructed by hand rather than recovered or measured.

// The upper of the two middle values on an even-length set, which is the
// convention the probe that produced run 2 used. It matters: averaging the two
// middle values instead gives Middle East 17 against the recorded 24 and Europe
// 108 against the recorded 113, so an averaging median would make the recorded
// output disagree with itself. The two odd-length theatres are unaffected.
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const inTheatre = (theatre) => CANDIDATES.filter((candidate) => candidate.theatre === theatre);
const byId = (id) => CANDIDATES.find((candidate) => candidate.id === id);
const readingOf = (id, run) => byId(id)?.readings.find((reading) => reading.run === run)?.aircraft;
const zeroesIn = (run) => CANDIDATES
  .filter((candidate) => readingOf(candidate.id, run) === 0).map((candidate) => candidate.id).sort();

test('at least two runs are recorded, each with a date', () => {
  assert.ok(RUNS.length >= 2, 'a single run is not a measurement');
  for (const run of RUNS) {
    assert.match(run.probedAt, /^\d{4}-\d{2}-\d{2}/, `run ${run.id} probedAt`);
    assert.equal(run.radiusNm, 150);
  }
  assert.ok(RUNS.some((run) => run.id === 'run2'), 'run 2 is the recovered output');
  assert.ok(RUNS.some((run) => run.id === 'run3'), 'run 3 gives all 64 candidates a second reading');
});

test('the probe covered 64 candidates across four theatres', () => {
  assert.equal(CANDIDATES.length, 64);
  assert.equal(inTheatre('Europe').length, 20);
  assert.equal(inTheatre('North East Asia').length, 15);
  assert.equal(inTheatre('United States').length, 15);
  assert.equal(inTheatre('Middle East').length, 14);
});

test("run 2's per-theatre totals and medians match the recorded output", () => {
  const check = (theatre, expectedTotal, expectedMedian) => {
    const counts = inTheatre(theatre).map((candidate) => readingOf(candidate.id, 'run2'));
    assert.ok(counts.every((count) => Number.isInteger(count)), `${theatre} is missing a run2 reading`);
    assert.equal(counts.reduce((sum, count) => sum + count, 0), expectedTotal, `${theatre} run2 total`);
    assert.equal(median(counts), expectedMedian, `${theatre} run2 median`);
  };
  check('North East Asia', 720, 42);
  check('Middle East', 278, 24);
  check('Europe', 3861, 113);
  check('United States', 320, 24);
});

test("run 2's named per-candidate readings match the recorded output", () => {
  const expected = {
    tokyo: 121, yokohama: 123, osaka: 105, busan: 55, seoul: 73, shanghai: 5,
    ningbo: 1, shenzhen: 40, hongkong: 41, qingdao: 3, tianjin: 46,
    kaohsiung: 13, taipei: 52, vladivostok: 0, taiwanstrait: 42,
    dubai: 25, jebelali: 26, abudhabi: 24, doha: 10, jeddah: 0, dammam: 7,
    kuwait: 0, muscat: 33, manama: 8, haifa: 46, beirut: 55, hormuz: 8,
    suez: 36, babelmandeb: 0,
    antwerp: 448, lehavre: 380, marseille: 186, barcelona: 201, valencia: 99,
    algeciras: 52, gibraltar: 50, piraeus: 113, genoa: 273, trieste: 261,
    gdansk: 72, klaipeda: 50, constanta: 79, odesa: 1, istanbul: 89,
    felixstowe: 563, dover: 554, copenhagen: 103, gothenburg: 79, kiel: 208,
    houston: 14, seattle: 24, savannah: 11, charleston: 11, norfolk: 30,
    sandiego: 39, miami: 17, chicago: 30, honolulu: 4, neworleans: 9,
    baltimore: 51, oakland: 26, boston: 29, anchorage: 25, guam: 0,
  };
  assert.equal(Object.keys(expected).length, 64, 'the transcription covers every candidate');
  for (const [id, aircraft] of Object.entries(expected)) {
    assert.equal(readingOf(id, 'run2'), aircraft, `${id} run2`);
  }
});

test("run 1's surviving per-candidate readings are recorded as run 1", () => {
  // Only these eleven survive; run 1's full table is lost. The artefact must not
  // invent the other 53, and must not silently relabel run 2 as run 1.
  const survived = {
    felixstowe: 541, dover: 550, antwerp: 434, shanghai: 5, qingdao: 1,
    ningbo: 0, vladivostok: 0, jeddah: 0, kuwait: 0, babelmandeb: 0, guam: 0,
  };
  for (const [id, aircraft] of Object.entries(survived)) {
    assert.equal(readingOf(id, 'run1'), aircraft, `${id} run1`);
  }
  const withRun1 = CANDIDATES.filter((candidate) => candidate.readings.some((reading) => reading.run === 'run1'));
  assert.equal(withRun1.length, 11,
    'run 1 has readings for exactly the eleven candidates that survived');
});

test('the two recorded runs disagree about ningbo and agree about the other five', () => {
  // This is the finding the whole coverage design rests on. If it stops being
  // true the design needs revisiting, not the assertion.
  assert.deepEqual(zeroesIn('run1'),
    ['babelmandeb', 'guam', 'jeddah', 'kuwait', 'ningbo', 'vladivostok']);
  assert.deepEqual(zeroesIn('run2'),
    ['babelmandeb', 'guam', 'jeddah', 'kuwait', 'vladivostok']);
});

test('every candidate has at least two readings once run 3 lands', () => {
  for (const candidate of CANDIDATES) {
    assert.ok(candidate.readings.length >= 2,
      `${candidate.id} has ${candidate.readings.length} reading(s) — one run is not a measurement`);
  }
});

test('run 3 tracks its own theatre closely enough to rule out a wrong coordinate', () => {
  // The coordinate table was rebuilt from scratch, so a transcription error puts
  // a probe centre in the wrong place and the count collapses. The check is
  // whether a candidate moved differently from the theatre around it.
  //
  // It has to be posed that way, because the raw run3/run2 ratio measures
  // whatever moved the whole THEATRE, not the geography. Run 3 completed
  // 2026-08-16T18:50:45Z, which was recorded. Run 2's hour was not recorded
  // anywhere and is not assumed here. What IS measured is that the theatres
  // moved enormously between the two, and in opposite directions: United States
  // 320 -> 3,353 aircraft, North East Asia 720 -> 178, Europe 3,861 -> 2,382,
  // Middle East 278 -> 395.
  //
  // A flat "no candidate moved more than 10x" rule fails on this data against
  // five correct US coordinates — seattle 24 -> 290, sandiego 39 -> 433, chicago
  // 30 -> 323, oakland 26 -> 385, boston 29 -> 395 — while ignoring the seven
  // other US candidates that moved by the same multiple and refute it, because
  // they fall below its own floor. All twelve contiguous-US candidates moved in
  // the same direction by 7.2x to 16.5x. Twelve coordinates are not wrong in
  // concert; one theatre-wide cause is the parsimonious explanation, most likely
  // the hour.
  //
  // So each candidate is measured against its theatre's own median move, which
  // divides out that cause whatever it was. Measured on runs 2 and 3, the worst
  // departure anywhere is anchorage at 5.9x — Alaska not moving with the
  // contiguous states, rather than a bad centre — so a 10x threshold still sits
  // clear of the noise.
  //
  // Three limits worth knowing:
  //   * It skips every candidate reading under 20 in run 2, which is 24 of 64.
  //   * The per-theatre baselines are thin. Measured on runs 2 and 3: Europe
  //     n=19, United States n=8, Middle East n=7, North East Asia n=10. The
  //     Middle East baseline is the thinnest and it carries both of the
  //     candidates pinned in TRANSPOSES_ITS_OWN_ENVELOPE_ADMITS below.
  //   * Because the baseline comes from the same readings, it cannot see a whole
  //     theatre being wrong together.
  // The geometry tests below are what cover the second and third.
  const ratiosByTheatre = new Map();
  const paired = [];
  for (const candidate of CANDIDATES) {
    const run2 = readingOf(candidate.id, 'run2');
    const run3 = readingOf(candidate.id, 'run3');
    if (run2 == null || run3 == null || run2 < 20) continue;
    paired.push({ id: candidate.id, theatre: candidate.theatre, run2, run3, ratio: run3 / run2 });
    if (!ratiosByTheatre.has(candidate.theatre)) ratiosByTheatre.set(candidate.theatre, []);
    ratiosByTheatre.get(candidate.theatre).push(run3 / run2);
  }
  assert.ok(paired.length >= 40,
    `only ${paired.length} candidates have a comparable pair of readings (44 on runs 2 and 3) ` +
    '— below 40 the per-theatre baselines are too thin to divide anything out and the check has gone hollow');

  const suspect = [];
  for (const pair of paired) {
    // Median rather than the theatre total, so one large region cannot set the
    // baseline for the small ones beside it.
    const theatreMove = median(ratiosByTheatre.get(pair.theatre));
    const relative = pair.ratio / theatreMove;
    const departure = relative === 0 ? Infinity : Math.max(relative, 1 / relative);
    if (departure > 10) {
      suspect.push(`${pair.id}: run2=${pair.run2} run3=${pair.run3}, ${departure.toFixed(1)}x its theatre`);
    }
  }
  assert.deepEqual(suspect, [],
    'these centres moved differently from every region around them — re-check their coordinates');
});

// ---------------------------------------------------------------------------
// Geometry. A swapped lon/lat pair is the commonest data-entry error at this
// scale, and NEITHER guard already in the repo catches one:
//
//   * test/region-schema.test.js 'every region centre lies inside its own
//     bounding box' cannot, for anything place() builds, because place()
//     derives the bbox FROM the centre. The assertion compares an output
//     against itself and holds for [999, -999].
//   * test/region-schema.test.js 'every region centre is a valid coordinate'
//     cannot either, because both components of a real-world coordinate
//     usually sit inside +/-90, so a transposed pair passes the latitude
//     range test. Sydney's centre would fail it only because its longitude of
//     151.228 happens to exceed 90, which is luck rather than coverage. Of the
//     64 candidates here, exactly one — guam at 144.72E — is protected by that
//     accident.
//
// So the check has to be against something the candidate does not itself
// define, and the theatre is it: a North East Asia candidate at longitude 35,
// latitude 139 is in the wrong hemisphere for the theatre it declares.
//
// FOUR rectangles for 64 candidates. They are written from each theatre's
// geographic extent, deliberately NOT computed from the candidate coordinates —
// a per-candidate bound would be the same constant written twice, which proves
// nothing. The margins are loose on purpose, and two further tests below measure
// whether they still discriminate: one that they reject transposed centres, and
// one that they do not swallow each other's candidates.
const THEATRE_ENVELOPES = {
  'North East Asia': {
    // The south China coast through the Korean peninsula to the Japanese
    // archipelago: Shenzhen and Hong Kong in the south-west, Vladivostok and
    // Hokkaido in the north-east. Nothing here is inland Asia or open Pacific.
    west: 105, east: 146, south: 18, north: 46,
  },
  'Middle East': {
    // The Suez Canal and the Red Sea in the west to the Gulf of Oman in the
    // east; Bab el-Mandeb in the south to the Levant coast in the north.
    // Turkey is filed under Europe in this catalogue, so the northern edge is
    // the Syrian coast rather than Anatolia.
    //
    // West is 32 and not 30 because 32 is what the sentence above actually
    // describes: the Suez Canal sits at 32.35E and the entire western shore of
    // the Gulf of Suez and the Red Sea lies east of 32E. A west edge of 30
    // reached Cairo and the Nile Delta, which this theatre never claimed, and
    // it was the only thing letting a transposed suez through.
    west: 32, east: 62, south: 10, north: 36,
  },
  Europe: {
    // The Iberian Atlantic coast east to the Black Sea, and the Strait of
    // Gibraltar north to the Baltic and the Skagerrak.
    west: -11, east: 42, south: 34, north: 62,
  },
  'United States': {
    // The one theatre that crosses the antimeridian: Guam and the Marianas in
    // the western Pacific, through Hawaii and Alaska, to the Maine coast. So
    // `west` is greater than `east` here and the longitude test wraps.
    //
    // West is 142, in open ocean west of the Marianas, and not 140: at 140 this
    // envelope reached back over Japan and sat 0.23 degrees from tokyo at
    // 139.7671E, so a Tokyo-area centre nudged east — Narita is 140.39E — would
    // have fallen inside a foreign theatre's envelope. 142 clears the whole
    // North East Asia theatre by 2.23 degrees and still holds guam at 144.72E.
    west: 142, east: -64, south: 10, north: 66,
  },
};

// A longitude range that may cross the antimeridian. west > east means the
// range is [west, 180] together with [-180, east].
const longitudeInside = (lon, { west, east }) =>
  (west <= east ? (lon >= west && lon <= east) : (lon >= west || lon <= east));

const insideEnvelope = ([lon, lat], envelope) =>
  longitudeInside(lon, envelope) && lat >= envelope.south && lat <= envelope.north;

test('every candidate centre falls inside its declared theatre envelope', () => {
  for (const candidate of CANDIDATES) {
    const envelope = THEATRE_ENVELOPES[candidate.theatre];
    assert.ok(envelope,
      `${candidate.id} declares theatre "${candidate.theatre}", which has no envelope`);
    const [lon, lat] = candidate.center;
    assert.ok(insideEnvelope(candidate.center, envelope),
      `${candidate.id} centre [${lon}, ${lat}] is outside the ${candidate.theatre} envelope ` +
      `(lon ${envelope.west}..${envelope.east}, lat ${envelope.south}..${envelope.north}) ` +
      '— a swapped lon/lat pair looks exactly like this');
  }
});

// The two candidates whose coordinates sit close enough to the 45-degree
// diagonal that their OWN theatre's rectangle does not separate them from their
// transposition. They are not uncaught — see below — but this test alone does
// not catch them, and pinning the list keeps that honest.
//
// Why the Middle East envelope is not simply tightened until it does. It could
// be: a rectangle rejecting all fourteen Middle East transposes exists, and
// { west 32, north 34.5 } is one. Beirut at 33.90N only forces north >= 33.90
// while excluding haifa's transpose [32.82, 34.995] needs north < 34.995, so
// the window is open. That is a TRADE-OFF and not an impossibility, and an
// earlier version of this comment was wrong to claim otherwise.
//
// It is declined because north: 36 is what "the Levant coast" means — Syria's
// coastline reaches about 35.9N, and Latakia at 35.52N and Tartus at 34.89N are
// exactly the candidates this theatre would gain next. Cutting the edge to 34.5
// would buy two transpositions by excluding real Middle East geography, which is
// fitting the envelope to the 64 rows that exist today rather than to the
// theatre. The west edge was a different case and WAS taken: 30 -> 32 excludes
// no Middle East geography at all, and it moved suez out of this list.
//
// What does catch these two: 'no candidate centre falls inside a theatre
// envelope other than its own', below. Transposed haifa [32.82, 34.995] and
// transposed beirut [33.90, 35.515] both land inside the EUROPE envelope, so the
// foreign-containment check fails on them even though their own theatre's
// rectangle admits them. Verified by mutation — transposing either centre in the
// artefact turns that test red. Between the two tests every one of the 64
// transpositions is caught.
//
// The two are therefore coupled: tightening Europe's southern or western edge
// could open a real gap here. Anything that moves the Europe envelope should
// re-run the transposition sweep rather than assume this still holds.
//
// Note what does NOT back them up: the theatre-relative check above only catches
// a centre whose count COLLAPSES, and a near-diagonal transposition is a small
// geographic move. Transposed haifa is open Mediterranean about 110 km west of
// Cyprus, and a 150 nm probe from there still sweeps Cyprus, southern Turkey,
// Lebanon and Israel, so it would read a similar count and pass.
const TRANSPOSES_ITS_OWN_ENVELOPE_ADMITS = ['beirut', 'haifa'];

test('the theatre envelopes would reject a swapped lon/lat pair', () => {
  // Gives the envelopes above discriminating power rather than mere truth.
  // Without it, generous rectangles could pass the previous test while
  // excluding nothing at all.
  //
  // It also fixes the blind spot in place: a new candidate whose transposition
  // survives has to be added to the list consciously and verified by hand,
  // rather than quietly joining it.
  //
  // Measured reach, because it is not uniform: replacing an envelope with the
  // whole globe breaks this test for Europe, Middle East and United States, but
  // NOT for North East Asia. Every North East Asia longitude exceeds 105, so
  // every transposed NEA centre has a latitude of 105-146 and falls outside
  // +/-90 regardless of the envelope. This test therefore verifies three of the
  // four envelopes; the fourth is covered by the foreign-containment test below,
  // and a transposed NEA centre is in any case caught by the +/-90 range check
  // in 'every candidate row is well formed'.
  const survives = [];
  for (const candidate of CANDIDATES) {
    const [lon, lat] = candidate.center;
    if (insideEnvelope([lat, lon], THEATRE_ENVELOPES[candidate.theatre])) survives.push(candidate.id);
  }
  assert.deepEqual(survives.sort(), TRANSPOSES_ITS_OWN_ENVELOPE_ADMITS,
    'a transposed centre survives its own theatre envelope for these candidates — ' +
    'either the coordinate is wrong, or the envelope no longer discriminates. ' +
    'The two expected entries are caught instead by the foreign-containment test below');

  // The pinned pair is caught by a DIFFERENT envelope, and until now that was a
  // comment rather than a guard. Transposed beirut and haifa land inside Europe,
  // so Europe's southern edge is load-bearing for two Middle East rows that
  // nothing in the Middle East protects.
  //
  // The window is narrow and silent: Europe's lowest candidate is gibraltar at
  // 35.95N, and excluding haifa's transpose needs south < 34.995. Any Europe
  // south in (34.995, 35.95] still contains every Europe candidate, so its own
  // containment test stays green while haifa's transpose escapes entirely. That
  // is 0.96 degrees of undetected coupling.
  //
  // Asserting it here costs three lines and means a future edit to a Europe
  // boundary cannot silently reopen a Middle East hole.
  for (const id of TRANSPOSES_ITS_OWN_ENVELOPE_ADMITS) {
    const candidate = CANDIDATES.find((c) => c.id === id);
    const [lon, lat] = candidate.center;
    const caughtBy = Object.entries(THEATRE_ENVELOPES)
      .filter(([theatre]) => theatre !== candidate.theatre)
      .filter(([, envelope]) => insideEnvelope([lat, lon], envelope))
      .map(([theatre]) => theatre);
    assert.ok(caughtBy.length > 0,
      `transposed ${id} escapes every envelope: it survives its own theatre's, which is ` +
      'expected and pinned, but no other theatre contains it either, so nothing catches it. ' +
      'A Europe boundary was probably moved — see the foreign-containment test.');
  }
});

test('no candidate centre falls inside a theatre envelope other than its own', () => {
  // The anti-vacuity check that covers all four envelopes, including North East
  // Asia, which the transposition pin above cannot reach. An envelope widened
  // towards uselessness swallows its neighbours' candidates and fails here:
  // measured, replacing any one of the four with the whole globe puts 44 to 50
  // foreign centres inside it.
  //
  // It carries two further loads. It is a real claim in its own right — the four
  // envelopes partition the catalogue, so a candidate filed under the wrong
  // theatre is caught even when its coordinate is perfectly correct, and Task 6
  // groups the picker by theatre where a row in the wrong group is visible. And
  // it is what catches the two transpositions the previous test cannot: both
  // transposed haifa and transposed beirut land inside the Europe envelope.
  // Between the two tests, all 64 transpositions are caught.
  //
  // Tightest margins on the committed table: tokyo at 139.7671E sits 2.23
  // degrees west of the United States envelope, and guam at 13.45N sits 4.55
  // degrees south of the North East Asia envelope. The Middle East and Europe
  // envelopes do overlap on paper, over lon 32..42 and lat 34..36, but no
  // candidate of either theatre lies in that box.
  const misfiled = [];
  for (const candidate of CANDIDATES) {
    for (const [theatre, envelope] of Object.entries(THEATRE_ENVELOPES)) {
      if (theatre === candidate.theatre) continue;
      if (insideEnvelope(candidate.center, envelope)) {
        misfiled.push(`${candidate.id} (${candidate.theatre}) is inside the ${theatre} envelope`);
      }
    }
  }
  assert.deepEqual(misfiled, [],
    'these centres sit inside a theatre they do not belong to — either the row is filed ' +
    'under the wrong theatre, or an envelope has been widened until it no longer discriminates');
});

test('the nine chokepoints are typed as straits and carry no country', () => {
  const straits = CANDIDATES.filter((candidate) => candidate.type === 'strait').map((candidate) => candidate.id).sort();
  assert.deepEqual(straits, [
    'babelmandeb', 'copenhagen', 'dover', 'gibraltar', 'hormuz',
    'istanbul', 'kiel', 'suez', 'taiwanstrait',
  ]);
  for (const strait of CANDIDATES.filter((candidate) => candidate.type === 'strait')) {
    assert.equal(strait.country, null, `${strait.id} carries a country`);
  }
});

test('every candidate row is well formed', () => {
  const seen = new Set();
  for (const candidate of CANDIDATES) {
    assert.match(candidate.id, /^[a-z0-9]+$/, `id "${candidate.id}" must be lower-case alphanumeric`);
    assert.ok(!seen.has(candidate.id), `duplicate candidate id "${candidate.id}"`);
    seen.add(candidate.id);
    assert.ok(candidate.name && typeof candidate.name === 'string', `${candidate.id} has no name`);
    assert.equal(candidate.center.length, 2, `${candidate.id} centre is not a pair`);
    const [lon, lat] = candidate.center;
    // Catches a transposed North East Asia centre, whose longitude exceeds 105
    // and so becomes an impossible latitude. It catches nothing of the sort for
    // the other three theatres — see the envelope tests above.
    assert.ok(lon >= -180 && lon <= 180, `${candidate.id} longitude ${lon}`);
    assert.ok(lat >= -90 && lat <= 90, `${candidate.id} latitude ${lat}`);
    assert.ok(['city', 'strait'].includes(candidate.type), `${candidate.id} type ${candidate.type}`);
    for (const reading of candidate.readings) {
      assert.ok(RUNS.some((run) => run.id === reading.run),
        `${candidate.id} cites unknown run "${reading.run}"`);
      assert.ok(Number.isInteger(reading.aircraft) && reading.aircraft >= 0,
        `${candidate.id} ${reading.run} aircraft ${reading.aircraft}`);
    }
  }
});

test('no candidate collides with a region that already exists', async () => {
  const { register } = await import('node:module');
  const jsonImportShim = `
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
        return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
      }
      return nextLoad(url, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);
  const { REGIONS } = await import('../lib/regions.js');
  // Task 6 spreads the catalogue into REGIONS, so a collision would silently
  // overwrite a hand-tuned region — sydney's bbox, canberra's Deep Space Network
  // layer — with a factory default and no error anywhere.
  const preExisting = [
    'world', 'sydney', 'canberra', 'melbourne', 'sanfrancisco', 'washington',
    'london', 'telaviv', 'auckland', 'wellington', 'singapore', 'rotterdam',
    'hamburg', 'amsterdam', 'newyork', 'losangeles', 'australia',
    'unitedstates', 'southpacific',
  ];
  assert.equal(preExisting.length, 19, 'the pre-expansion region count is 19');
  for (const id of preExisting) assert.ok(REGIONS[id], `${id} is no longer in REGIONS`);
  for (const candidate of CANDIDATES) {
    assert.ok(!preExisting.includes(candidate.id),
      `candidate "${candidate.id}" collides with an existing region — resolve by dropping the candidate and keeping the existing region, then adjust the expected count in test/region-schema.test.js`);
  }
});
