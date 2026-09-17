// Re-measures ADS-B feeder coverage for every region candidate.
//
//   node ingest/probe-region-candidates.mjs run3 > run3-candidates.js
//
// Hits adsb.fi once per candidate at PROBE_RADIUS_NM, paced at 1.2 s — the
// pacing runs 1 and 2 used, and slow enough to stay polite on a free volunteer
// network that carries no rate-limit headers. Emits a replacement CANDIDATES
// block on stdout with a new reading appended to every row, and a run-2-shaped
// transcript on stderr for docs/measurements/.
//
// COORDINATE PROVENANCE. Runs 1 and 2 were driven by a script that no longer
// exists, and neither output recorded the centres it used. The table below was
// rebuilt from the candidate names in
// docs/measurements/2026-08-16-region-coverage-probe-run2.txt. From run 3 onward
// the geography is version-controlled and every reading is comparable. Runs 1
// and 2 are kept as prior evidence with the caveat that their centres may differ
// from these by some tens of nautical miles inside a 150 nm catchment. That
// cannot turn a reproducible zero into a non-zero — a feeder either exists in
// the region or does not — but it can move a mid-range count by more than the
// run-to-run noise, so a run-1-to-run-3 comparison on a mid-range region is not
// a like-for-like one.
//
// Counts vary by hour, and only run 3's hour is known. The design spec records
// that run 1's Dover reading of 550 was taken mid-European-afternoon; run 2
// wrote down no time at all, and its Dover reads 554, so run 1's note does not
// carry over to it. Theatre totals moved -5.1% to +5.6% between runs 1 and 2
// while individual low-count regions moved by multiples, and between runs 2 and
// 3 whole theatres moved by an order of magnitude in opposite directions. The
// load-bearing output is which regions read zero in EVERY run, which is what
// lib/adsb-coverage.js consumes and which no plausible hour changes.

const PROBE_RADIUS_NM = 150;
const PACING_MS = 1200;
const USER_AGENT = 'parallax-region-probe/1.0 (maritime common operating picture; ADS-B coverage survey)';

// id, name, theatre, country, type, [lon, lat]
//
// SOURCE: the port authority's or waterway administration's own published
// position where the candidate names a port or a canal, the narrowest point of
// the channel where it names a strait, and the settlement centroid otherwise.
// Compound names (Dammam / Ras Tanura, Seattle / Tacoma, Marseille / Fos,
// Guam / Apra Harbor, Ningbo-Zhoushan, Istanbul / Bosphorus) take a point
// between the two named places, since a 150 nm probe covers both comfortably.
// Sourced on the date of run 3. Ordered as run 2 reported.
//
// `center` is [longitude, latitude], matching place() and GeoJSON. A swapped
// pair here is the failure mode that puts a region in the wrong place on an
// operator's map, and test/region-probe-artefact.test.js checks every centre
// against its theatre's envelope for exactly that reason.
const CANDIDATE_GEOGRAPHY = [
  // ---- North East Asia ----
  ['tokyo', 'Tokyo', 'North East Asia', 'JP', 'city', [139.7671, 35.6812]],
  ['yokohama', 'Yokohama', 'North East Asia', 'JP', 'city', [139.6667, 35.4500]],
  ['osaka', 'Osaka', 'North East Asia', 'JP', 'city', [135.4300, 34.6400]],
  ['busan', 'Busan', 'North East Asia', 'KR', 'city', [129.0400, 35.1000]],
  ['seoul', 'Seoul', 'North East Asia', 'KR', 'city', [126.9780, 37.5665]],
  ['shanghai', 'Shanghai', 'North East Asia', 'CN', 'city', [121.4737, 31.2304]],
  ['ningbo', 'Ningbo-Zhoushan', 'North East Asia', 'CN', 'city', [121.8800, 29.9300]],
  ['shenzhen', 'Shenzhen', 'North East Asia', 'CN', 'city', [114.0579, 22.5431]],
  ['hongkong', 'Hong Kong', 'North East Asia', 'HK', 'city', [114.1694, 22.3193]],
  ['qingdao', 'Qingdao', 'North East Asia', 'CN', 'city', [120.3200, 36.0800]],
  ['tianjin', 'Tianjin', 'North East Asia', 'CN', 'city', [117.7800, 38.9800]],
  ['kaohsiung', 'Kaohsiung', 'North East Asia', 'TW', 'city', [120.2800, 22.6100]],
  ['taipei', 'Taipei', 'North East Asia', 'TW', 'city', [121.5654, 25.0330]],
  ['vladivostok', 'Vladivostok', 'North East Asia', 'RU', 'city', [131.8869, 43.1155]],
  // Narrowest point of the strait, between Pingtan Island and Hsinchu.
  ['taiwanstrait', 'Taiwan Strait', 'North East Asia', null, 'strait', [120.3800, 25.1500]],

  // ---- Middle East ----
  ['dubai', 'Dubai', 'Middle East', 'AE', 'city', [55.2708, 25.2048]],
  ['jebelali', 'Jebel Ali', 'Middle East', 'AE', 'city', [55.0300, 25.0000]],
  ['abudhabi', 'Abu Dhabi', 'Middle East', 'AE', 'city', [54.3773, 24.4539]],
  ['doha', 'Doha', 'Middle East', 'QA', 'city', [51.5310, 25.2854]],
  ['jeddah', 'Jeddah', 'Middle East', 'SA', 'city', [39.1728, 21.5433]],
  ['dammam', 'Dammam / Ras Tanura', 'Middle East', 'SA', 'city', [50.1300, 26.5400]],
  ['kuwait', 'Kuwait City', 'Middle East', 'KW', 'city', [47.9783, 29.3759]],
  ['muscat', 'Muscat', 'Middle East', 'OM', 'city', [58.5500, 23.6100]],
  ['manama', 'Manama', 'Middle East', 'BH', 'city', [50.5860, 26.2285]],
  ['haifa', 'Haifa', 'Middle East', 'IL', 'city', [34.9950, 32.8200]],
  ['beirut', 'Beirut', 'Middle East', 'LB', 'city', [35.5150, 33.9000]],
  // Narrowest point of the strait, between the Musandam peninsula and Larak.
  ['hormuz', 'Strait of Hormuz', 'Middle East', null, 'strait', [56.2500, 26.5700]],
  // Mid-canal, near Ismailia: a canal has no narrowest point worth the name.
  ['suez', 'Suez Canal', 'Middle East', null, 'strait', [32.3500, 30.5900]],
  // Narrowest point of the strait, between Ras Menheli and Ras Siyyan.
  ['babelmandeb', 'Bab el-Mandeb', 'Middle East', null, 'strait', [43.4000, 12.5800]],

  // ---- Europe ----
  ['antwerp', 'Antwerp', 'Europe', 'BE', 'city', [4.3300, 51.2800]],
  ['lehavre', 'Le Havre', 'Europe', 'FR', 'city', [0.1050, 49.4850]],
  ['marseille', 'Marseille / Fos', 'Europe', 'FR', 'city', [5.1600, 43.3700]],
  ['barcelona', 'Barcelona', 'Europe', 'ES', 'city', [2.1700, 41.3600]],
  ['valencia', 'Valencia', 'Europe', 'ES', 'city', [-0.3200, 39.4500]],
  ['algeciras', 'Algeciras', 'Europe', 'ES', 'city', [-5.4400, 36.1300]],
  // Narrowest point of the strait, between Point Marroqui and Point Cires.
  ['gibraltar', 'Strait of Gibraltar', 'Europe', null, 'strait', [-5.6000, 35.9500]],
  ['piraeus', 'Piraeus', 'Europe', 'GR', 'city', [23.6200, 37.9400]],
  ['genoa', 'Genoa', 'Europe', 'IT', 'city', [8.9000, 44.4000]],
  ['trieste', 'Trieste', 'Europe', 'IT', 'city', [13.7600, 45.6400]],
  ['gdansk', 'Gdansk', 'Europe', 'PL', 'city', [18.6800, 54.3900]],
  ['klaipeda', 'Klaipeda', 'Europe', 'LT', 'city', [21.1300, 55.7000]],
  ['constanta', 'Constanta', 'Europe', 'RO', 'city', [28.6500, 44.1500]],
  ['odesa', 'Odesa', 'Europe', 'UA', 'city', [30.7300, 46.4900]],
  // Between the city and the narrows of the Bosphorus at Kandilli.
  ['istanbul', 'Istanbul / Bosphorus', 'Europe', null, 'strait', [29.0200, 41.0500]],
  ['felixstowe', 'Felixstowe', 'Europe', 'GB', 'city', [1.3200, 51.9500]],
  // Narrowest point of the strait, between South Foreland and Cap Gris-Nez.
  ['dover', 'Dover Strait', 'Europe', null, 'strait', [1.4800, 51.0100]],
  // Narrowest point of the Oresund, between Helsingor and Helsingborg.
  ['copenhagen', 'Danish Straits', 'Europe', null, 'strait', [12.6200, 56.0300]],
  ['gothenburg', 'Gothenburg', 'Europe', 'SE', 'city', [11.9000, 57.7000]],
  // Midway between the two locks, Brunsbuttel and Kiel-Holtenau. Not literally
  // on the canal: it bulges north through Rendsburg at 54.30N, so the
  // straight-line midpoint sits ~18 km south of the water. Immaterial inside a
  // 150 nm catchment, but the comment should not claim otherwise.
  ['kiel', 'Kiel Canal', 'Europe', null, 'strait', [9.6500, 54.1300]],

  // ---- United States ----
  ['houston', 'Houston', 'United States', 'US', 'city', [-95.3000, 29.7500]],
  ['seattle', 'Seattle / Tacoma', 'United States', 'US', 'city', [-122.3900, 47.4300]],
  ['savannah', 'Savannah', 'United States', 'US', 'city', [-81.0900, 32.0800]],
  ['charleston', 'Charleston', 'United States', 'US', 'city', [-79.9311, 32.7765]],
  ['norfolk', 'Norfolk', 'United States', 'US', 'city', [-76.2859, 36.8508]],
  ['sandiego', 'San Diego', 'United States', 'US', 'city', [-117.1611, 32.7157]],
  ['miami', 'Miami', 'United States', 'US', 'city', [-80.1918, 25.7617]],
  ['chicago', 'Chicago', 'United States', 'US', 'city', [-87.6298, 41.8781]],
  ['honolulu', 'Honolulu', 'United States', 'US', 'city', [-157.8583, 21.3069]],
  ['neworleans', 'New Orleans', 'United States', 'US', 'city', [-90.0715, 29.9511]],
  ['baltimore', 'Baltimore', 'United States', 'US', 'city', [-76.6122, 39.2904]],
  ['oakland', 'Oakland', 'United States', 'US', 'city', [-122.2711, 37.8044]],
  ['boston', 'Boston', 'United States', 'US', 'city', [-71.0589, 42.3601]],
  ['anchorage', 'Anchorage', 'United States', 'US', 'city', [-149.9003, 61.2181]],
  ['guam', 'Guam / Apra Harbor', 'United States', 'US', 'city', [144.7200, 13.4500]],
];

// Cheap self-checks before any network call. A table that is malformed on its
// face should not cost a volunteer network 64 requests to discover.
function assertTableIsWellFormed(rows) {
  const problems = [];
  if (rows.length !== 64) problems.push(`expected 64 candidates, found ${rows.length}`);
  const seen = new Set();
  for (const [id, name, theatre, country, type, center] of rows) {
    if (seen.has(id)) problems.push(`duplicate id ${id}`);
    seen.add(id);
    if (!/^[a-z0-9]+$/.test(id)) problems.push(`id ${id} is not lower-case alphanumeric`);
    if (!name || !theatre) problems.push(`${id} is missing a name or a theatre`);
    if (type !== 'city' && type !== 'strait') problems.push(`${id} has type ${type}`);
    if (type === 'strait' && country !== null) problems.push(`${id} is a strait carrying country ${country}`);
    if (type === 'city' && !country) problems.push(`${id} is a city carrying no country`);
    const [lon, lat] = center || [];
    if (!(lon >= -180 && lon <= 180)) problems.push(`${id} longitude ${lon}`);
    if (!(lat >= -90 && lat <= 90)) problems.push(`${id} latitude ${lat}`);
  }
  if (problems.length) {
    process.stderr.write(`coordinate table is malformed:\n${problems.join('\n')}\n`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function countAircraft([lon, lat]) {
  const url = `https://opendata.adsb.fi/api/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${PROBE_RADIUS_NM}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  // Named, not swallowed. A probe reporting 0 for a request that failed would
  // write a false blind verdict into the artefact, which is the one thing this
  // file must never do.
  if (!res.ok) throw new Error(`adsb.fi ${res.status} for ${lon},${lat}`);
  const data = await res.json();
  return (data.aircraft || data.ac || [])
    .filter((contact) => contact.lat != null && contact.lon != null).length;
}

// The upper of the two middle values on an even-length set. This is the
// convention the run-2 summary used — averaging instead gives Middle East 17
// where that file records 24 — and the two files are only comparable if run 3
// reports the same statistic.
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];

assertTableIsWellFormed(CANDIDATE_GEOGRAPHY);

const startedAt = new Date().toISOString();
const probedAt = startedAt.slice(0, 10);
const runId = process.argv[2] || 'run3';
const rows = [];
const failures = [];

// The full UTC timestamp, not just the date, and it is written because the
// earlier runs did NOT write it. Counts are strongly diurnal and the theatres do
// not share a clock: the United States theatre read 320 aircraft on run 2 and
// 3,353 on run 3, while North East Asia went 720 to 178. Run 2 recorded no time
// at all, so its hour has to be inferred from those moves rather than read off,
// and nobody can now tell a moved centre from a different hour on that pair. Any
// run from here on says exactly when it happened.
//
// Theatre names are the canonical ones from lib/regions.js THEATRES, so this
// transcript reads `North East Asia` where the run-2 file wrote `NE Asia`. That
// is a deliberate break from run 2's format: the two files no longer diff
// column-wise, and the unambiguous name is worth more than the diff.
process.stderr.write(
  `Probing adsb.fi at ${PROBE_RADIUS_NM} nm per candidate, paced at ${PACING_MS / 1000} s...\n` +
  `${runId}, started ${startedAt}. Centres from the committed table in ingest/probe-region-candidates.mjs.\n` +
  'Aircraft only: the news columns in the run 2 file came from a GDELT GKG pass this script does not run.\n\n' +
  `${'theatre'.padEnd(16)}${'id'.padEnd(15)}${'name'.padEnd(24)}${'aircraft'.padStart(8)}\n` +
  `${'-'.repeat(63)}\n`,
);

for (const [id, name, theatre, country, type, center] of CANDIDATE_GEOGRAPHY) {
  try {
    const aircraft = await countAircraft(center);
    rows.push({ id, name, theatre, country, type, center, aircraft });
    process.stderr.write(`${theatre.padEnd(16)}${id.padEnd(15)}${name.padEnd(24)}${String(aircraft).padStart(8)}\n`);
  } catch (err) {
    failures.push(`${id}: ${err.message}`);
    process.stderr.write(`${theatre.padEnd(16)}${id.padEnd(15)}${name.padEnd(24)}${'FAILED'.padStart(8)}  ${err.message}\n`);
  }
  await sleep(PACING_MS);
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} of ${CANDIDATE_GEOGRAPHY.length} probes failed:\n${failures.join('\n')}\n`);
  process.stderr.write('Nothing written — a partial run is not a measurement.\n');
  process.exit(1);
}

// Run 2's format carried an `errors=` column. This script cannot reach the
// summary with a failed probe — it exits above — so the field could only ever
// print `[none]` and is dropped rather than hardcoded to a value that reads as
// computed. A failed run reports its failures above and writes nothing.
process.stderr.write('\n--- summary by theatre ---\n');
for (const theatre of [...new Set(rows.map((row) => row.theatre))]) {
  const counts = rows.filter((row) => row.theatre === theatre).map((row) => row.aircraft);
  const zeroes = rows.filter((row) => row.theatre === theatre && row.aircraft === 0).map((row) => row.id);
  process.stderr.write(
    `${theatre.padEnd(16)}candidates=${counts.length}  ` +
    `aircraft total=${counts.reduce((a, b) => a + b, 0)}  median=${median(counts)}  ` +
    `zero-aircraft=[${zeroes.length ? zeroes.join(',') : 'none'}]\n`,
  );
}

const completedAt = new Date().toISOString();
process.stderr.write(`\n${runId} started ${startedAt}, completed ${completedAt}.\n`);

// Single-quoted throughout, including strings carrying a space or a slash, so
// the emitted artefact does not mix quote styles within one row.
const quoted = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const line = (row) =>
  `  Object.freeze({ id: ${quoted(row.id)}, name: ${quoted(row.name)}, theatre: ${quoted(row.theatre)}, ` +
  `country: ${row.country === null ? 'null' : quoted(row.country)}, type: ${quoted(row.type)}, ` +
  `center: [${row.center[0]}, ${row.center[1]}], ` +
  `readings: [/* merge prior runs */ Object.freeze({ run: ${quoted(runId)}, probedAt: ${quoted(probedAt)}, aircraft: ${row.aircraft} })] }),`;

process.stdout.write(
  `// ${runId} probed ${probedAt} at ${PROBE_RADIUS_NM} nm, started ${startedAt}\n` +
  `export const CANDIDATES = Object.freeze([\n${rows.map(line).join('\n')}\n]);\n`,
);
