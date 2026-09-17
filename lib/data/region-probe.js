// Probe artefact — ADS-B feeder coverage per region candidate, across runs.
//
// This is a record of measurements, not a configuration. Editing an `aircraft`
// value to make something look better is falsifying data. To change the numbers,
// run ingest/probe-region-candidates.mjs and append a run.
//
// Run 1's per-candidate table is lost; eleven of its readings survive because
// the design spec quoted them. Run 2 is complete. Run 3 was measured against the
// coordinate table now committed in the probe script, and is the first run whose
// centres are recoverable.
//
// WHEN THESE RUNS HAPPENED, and what is actually known. Run 3 completed
// 2026-08-16T18:50:45Z; that was recorded. Runs 1 and 2 recorded no time beyond
// the date — the design spec notes that run 1's Dover reading of 550 was taken
// mid-European-afternoon, but run 2's Dover reads 554 and carries no timestamp
// of its own, so run 2's hour is simply unknown.
//
// It matters because counts are strongly diurnal and the theatres do not share a
// clock. Between run 2 and run 3 the United States theatre went 320 -> 3,353
// aircraft while North East Asia went 720 -> 178. The natural reading is that
// run 2 fell in the European morning, roughly ten hours before run 3, but that
// is INFERRED from the very counts it would explain and is not evidence. A
// second candidate explanation exists and is weaker but not excluded: runs 1 and
// 2 came from the deleted script and run 3 from the committed table, so a
// systematic difference in centres could also move theatre totals. At 10.5x it
// is an implausible amount of movement to attribute to centres inside a 150 nm
// catchment, which is why the hour is the better explanation rather than the
// proven one.
//
// Nothing downstream depends on resolving it. Any comparison of absolute counts
// across runs has to account for whatever moved the theatre; what does not move
// with it, and what lib/adsb-coverage.js consumes, is which regions read zero in
// every run.
//
// A .js module rather than .json on purpose: lib/config.js already imports a
// JSON module without an import attribute, and every test that reaches it has to
// install a loader shim to work around that on Node 22.

export const RUNS = Object.freeze([
  Object.freeze({ id: 'run1', probedAt: '2026-08-16', radiusNm: 150,
    note: 'Aggregates only; per-candidate table lost, and the centres it probed are unrecoverable. Eleven readings survive via the design spec. Time of day not recorded; the spec describes its Dover reading as mid-European-afternoon.' }),
  Object.freeze({ id: 'run2', probedAt: '2026-08-16', radiusNm: 150,
    note: 'Complete, but centres unrecoverable and time of day not recorded. docs/measurements/2026-08-16-region-coverage-probe-run2.txt' }),
  Object.freeze({ id: 'run3', probedAt: '2026-08-16', radiusNm: 150,
    note: 'First run against the committed coordinate table. Completed 2026-08-16T18:50:45Z, the only run whose time is recorded. docs/measurements/2026-08-16-region-coverage-probe-run3.txt' }),
]);

// One row per candidate, in the order run 2 reported. `center` is
// [longitude, latitude], matching place() and GeoJSON.
//
// The centres are the table committed in ingest/probe-region-candidates.mjs and
// were probed as such for run 3. They are NOT provably the centres runs 1 and 2
// used — that script was deleted and neither output recorded them — so those two
// runs are prior evidence whose centres may differ by some tens of nautical
// miles inside a 150 nm catchment.
export const CANDIDATES = Object.freeze([
  Object.freeze({ id: 'tokyo', name: 'Tokyo', theatre: 'North East Asia', country: 'JP', type: 'city',
    center: [139.7671, 35.6812], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 121 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 24 }),
    ]) }),
  Object.freeze({ id: 'yokohama', name: 'Yokohama', theatre: 'North East Asia', country: 'JP', type: 'city',
    center: [139.6667, 35.45], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 123 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 23 }),
    ]) }),
  Object.freeze({ id: 'osaka', name: 'Osaka', theatre: 'North East Asia', country: 'JP', type: 'city',
    center: [135.43, 34.64], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 105 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 21 }),
    ]) }),
  Object.freeze({ id: 'busan', name: 'Busan', theatre: 'North East Asia', country: 'KR', type: 'city',
    center: [129.04, 35.1], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 55 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 9 }),
    ]) }),
  Object.freeze({ id: 'seoul', name: 'Seoul', theatre: 'North East Asia', country: 'KR', type: 'city',
    center: [126.978, 37.5665], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 73 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 25 }),
    ]) }),
  Object.freeze({ id: 'shanghai', name: 'Shanghai', theatre: 'North East Asia', country: 'CN', type: 'city',
    center: [121.4737, 31.2304], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 5 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 5 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
  Object.freeze({ id: 'ningbo', name: 'Ningbo-Zhoushan', theatre: 'North East Asia', country: 'CN', type: 'city',
    center: [121.88, 29.93], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 1 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
  Object.freeze({ id: 'shenzhen', name: 'Shenzhen', theatre: 'North East Asia', country: 'CN', type: 'city',
    center: [114.0579, 22.5431], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 40 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 15 }),
    ]) }),
  Object.freeze({ id: 'hongkong', name: 'Hong Kong', theatre: 'North East Asia', country: 'HK', type: 'city',
    center: [114.1694, 22.3193], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 41 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 15 }),
    ]) }),
  Object.freeze({ id: 'qingdao', name: 'Qingdao', theatre: 'North East Asia', country: 'CN', type: 'city',
    center: [120.32, 36.08], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 1 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 3 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 1 }),
    ]) }),
  Object.freeze({ id: 'tianjin', name: 'Tianjin', theatre: 'North East Asia', country: 'CN', type: 'city',
    center: [117.78, 38.98], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 46 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 7 }),
    ]) }),
  Object.freeze({ id: 'kaohsiung', name: 'Kaohsiung', theatre: 'North East Asia', country: 'TW', type: 'city',
    center: [120.28, 22.61], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 13 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 2 }),
    ]) }),
  Object.freeze({ id: 'taipei', name: 'Taipei', theatre: 'North East Asia', country: 'TW', type: 'city',
    center: [121.5654, 25.033], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 52 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 19 }),
    ]) }),
  Object.freeze({ id: 'vladivostok', name: 'Vladivostok', theatre: 'North East Asia', country: 'RU', type: 'city',
    center: [131.8869, 43.1155], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
  Object.freeze({ id: 'taiwanstrait', name: 'Taiwan Strait', theatre: 'North East Asia', country: null, type: 'strait',
    center: [120.38, 25.15], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 42 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 17 }),
    ]) }),
  Object.freeze({ id: 'dubai', name: 'Dubai', theatre: 'Middle East', country: 'AE', type: 'city',
    center: [55.2708, 25.2048], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 25 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 46 }),
    ]) }),
  Object.freeze({ id: 'jebelali', name: 'Jebel Ali', theatre: 'Middle East', country: 'AE', type: 'city',
    center: [55.03, 25], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 26 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 49 }),
    ]) }),
  Object.freeze({ id: 'abudhabi', name: 'Abu Dhabi', theatre: 'Middle East', country: 'AE', type: 'city',
    center: [54.3773, 24.4539], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 24 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 54 }),
    ]) }),
  Object.freeze({ id: 'doha', name: 'Doha', theatre: 'Middle East', country: 'QA', type: 'city',
    center: [51.531, 25.2854], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 10 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 25 }),
    ]) }),
  Object.freeze({ id: 'jeddah', name: 'Jeddah', theatre: 'Middle East', country: 'SA', type: 'city',
    center: [39.1728, 21.5433], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
  Object.freeze({ id: 'dammam', name: 'Dammam / Ras Tanura', theatre: 'Middle East', country: 'SA', type: 'city',
    center: [50.13, 26.54], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 7 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 25 }),
    ]) }),
  Object.freeze({ id: 'kuwait', name: 'Kuwait City', theatre: 'Middle East', country: 'KW', type: 'city',
    center: [47.9783, 29.3759], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 1 }),
    ]) }),
  Object.freeze({ id: 'muscat', name: 'Muscat', theatre: 'Middle East', country: 'OM', type: 'city',
    center: [58.55, 23.61], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 33 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 48 }),
    ]) }),
  Object.freeze({ id: 'manama', name: 'Manama', theatre: 'Middle East', country: 'BH', type: 'city',
    center: [50.586, 26.2285], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 8 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 25 }),
    ]) }),
  Object.freeze({ id: 'haifa', name: 'Haifa', theatre: 'Middle East', country: 'IL', type: 'city',
    center: [34.995, 32.82], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 46 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 39 }),
    ]) }),
  Object.freeze({ id: 'beirut', name: 'Beirut', theatre: 'Middle East', country: 'LB', type: 'city',
    center: [35.515, 33.9], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 55 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 43 }),
    ]) }),
  Object.freeze({ id: 'hormuz', name: 'Strait of Hormuz', theatre: 'Middle East', country: null, type: 'strait',
    center: [56.25, 26.57], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 8 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 17 }),
    ]) }),
  Object.freeze({ id: 'suez', name: 'Suez Canal', theatre: 'Middle East', country: null, type: 'strait',
    center: [32.35, 30.59], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 36 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 23 }),
    ]) }),
  Object.freeze({ id: 'babelmandeb', name: 'Bab el-Mandeb', theatre: 'Middle East', country: null, type: 'strait',
    center: [43.4, 12.58], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
  Object.freeze({ id: 'antwerp', name: 'Antwerp', theatre: 'Europe', country: 'BE', type: 'city',
    center: [4.33, 51.28], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 434 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 448 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 240 }),
    ]) }),
  Object.freeze({ id: 'lehavre', name: 'Le Havre', theatre: 'Europe', country: 'FR', type: 'city',
    center: [0.105, 49.485], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 380 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 256 }),
    ]) }),
  Object.freeze({ id: 'marseille', name: 'Marseille / Fos', theatre: 'Europe', country: 'FR', type: 'city',
    center: [5.16, 43.37], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 186 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 117 }),
    ]) }),
  Object.freeze({ id: 'barcelona', name: 'Barcelona', theatre: 'Europe', country: 'ES', type: 'city',
    center: [2.17, 41.36], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 201 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 146 }),
    ]) }),
  Object.freeze({ id: 'valencia', name: 'Valencia', theatre: 'Europe', country: 'ES', type: 'city',
    center: [-0.32, 39.45], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 99 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 93 }),
    ]) }),
  Object.freeze({ id: 'algeciras', name: 'Algeciras', theatre: 'Europe', country: 'ES', type: 'city',
    center: [-5.44, 36.13], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 52 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 48 }),
    ]) }),
  Object.freeze({ id: 'gibraltar', name: 'Strait of Gibraltar', theatre: 'Europe', country: null, type: 'strait',
    center: [-5.6, 35.95], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 50 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 46 }),
    ]) }),
  Object.freeze({ id: 'piraeus', name: 'Piraeus', theatre: 'Europe', country: 'GR', type: 'city',
    center: [23.62, 37.94], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 113 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 88 }),
    ]) }),
  Object.freeze({ id: 'genoa', name: 'Genoa', theatre: 'Europe', country: 'IT', type: 'city',
    center: [8.9, 44.4], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 273 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 177 }),
    ]) }),
  Object.freeze({ id: 'trieste', name: 'Trieste', theatre: 'Europe', country: 'IT', type: 'city',
    center: [13.76, 45.64], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 261 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 164 }),
    ]) }),
  Object.freeze({ id: 'gdansk', name: 'Gdansk', theatre: 'Europe', country: 'PL', type: 'city',
    center: [18.68, 54.39], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 72 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 41 }),
    ]) }),
  Object.freeze({ id: 'klaipeda', name: 'Klaipeda', theatre: 'Europe', country: 'LT', type: 'city',
    center: [21.13, 55.7], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 50 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 34 }),
    ]) }),
  Object.freeze({ id: 'constanta', name: 'Constanta', theatre: 'Europe', country: 'RO', type: 'city',
    center: [28.65, 44.15], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 79 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 31 }),
    ]) }),
  Object.freeze({ id: 'odesa', name: 'Odesa', theatre: 'Europe', country: 'UA', type: 'city',
    center: [30.73, 46.49], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 1 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
  Object.freeze({ id: 'istanbul', name: 'Istanbul / Bosphorus', theatre: 'Europe', country: null, type: 'strait',
    center: [29.02, 41.05], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 89 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 58 }),
    ]) }),
  Object.freeze({ id: 'felixstowe', name: 'Felixstowe', theatre: 'Europe', country: 'GB', type: 'city',
    center: [1.32, 51.95], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 541 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 563 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 290 }),
    ]) }),
  Object.freeze({ id: 'dover', name: 'Dover Strait', theatre: 'Europe', country: null, type: 'strait',
    center: [1.48, 51.01], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 550 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 554 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 331 }),
    ]) }),
  Object.freeze({ id: 'copenhagen', name: 'Danish Straits', theatre: 'Europe', country: null, type: 'strait',
    center: [12.62, 56.03], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 103 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 74 }),
    ]) }),
  Object.freeze({ id: 'gothenburg', name: 'Gothenburg', theatre: 'Europe', country: 'SE', type: 'city',
    center: [11.9, 57.7], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 79 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 62 }),
    ]) }),
  Object.freeze({ id: 'kiel', name: 'Kiel Canal', theatre: 'Europe', country: null, type: 'strait',
    center: [9.65, 54.13], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 208 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 86 }),
    ]) }),
  Object.freeze({ id: 'houston', name: 'Houston', theatre: 'United States', country: 'US', type: 'city',
    center: [-95.3, 29.75], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 14 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 201 }),
    ]) }),
  Object.freeze({ id: 'seattle', name: 'Seattle / Tacoma', theatre: 'United States', country: 'US', type: 'city',
    center: [-122.39, 47.43], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 24 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 290 }),
    ]) }),
  Object.freeze({ id: 'savannah', name: 'Savannah', theatre: 'United States', country: 'US', type: 'city',
    center: [-81.09, 32.08], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 11 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 182 }),
    ]) }),
  Object.freeze({ id: 'charleston', name: 'Charleston', theatre: 'United States', country: 'US', type: 'city',
    center: [-79.9311, 32.7765], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 11 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 165 }),
    ]) }),
  Object.freeze({ id: 'norfolk', name: 'Norfolk', theatre: 'United States', country: 'US', type: 'city',
    center: [-76.2859, 36.8508], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 30 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 229 }),
    ]) }),
  Object.freeze({ id: 'sandiego', name: 'San Diego', theatre: 'United States', country: 'US', type: 'city',
    center: [-117.1611, 32.7157], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 39 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 433 }),
    ]) }),
  Object.freeze({ id: 'miami', name: 'Miami', theatre: 'United States', country: 'US', type: 'city',
    center: [-80.1918, 25.7617], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 17 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 243 }),
    ]) }),
  Object.freeze({ id: 'chicago', name: 'Chicago', theatre: 'United States', country: 'US', type: 'city',
    center: [-87.6298, 41.8781], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 30 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 323 }),
    ]) }),
  Object.freeze({ id: 'honolulu', name: 'Honolulu', theatre: 'United States', country: 'US', type: 'city',
    center: [-157.8583, 21.3069], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 4 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 6 }),
    ]) }),
  Object.freeze({ id: 'neworleans', name: 'New Orleans', theatre: 'United States', country: 'US', type: 'city',
    center: [-90.0715, 29.9511], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 9 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 89 }),
    ]) }),
  Object.freeze({ id: 'baltimore', name: 'Baltimore', theatre: 'United States', country: 'US', type: 'city',
    center: [-76.6122, 39.2904], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 51 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 365 }),
    ]) }),
  Object.freeze({ id: 'oakland', name: 'Oakland', theatre: 'United States', country: 'US', type: 'city',
    center: [-122.2711, 37.8044], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 26 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 385 }),
    ]) }),
  Object.freeze({ id: 'boston', name: 'Boston', theatre: 'United States', country: 'US', type: 'city',
    center: [-71.0589, 42.3601], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 29 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 395 }),
    ]) }),
  Object.freeze({ id: 'anchorage', name: 'Anchorage', theatre: 'United States', country: 'US', type: 'city',
    center: [-149.9003, 61.2181], readings: Object.freeze([
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 25 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 47 }),
    ]) }),
  Object.freeze({ id: 'guam', name: 'Guam / Apra Harbor', theatre: 'United States', country: 'US', type: 'city',
    center: [144.72, 13.45], readings: Object.freeze([
      Object.freeze({ run: 'run1', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run2', probedAt: '2026-08-16', aircraft: 0 }),
      Object.freeze({ run: 'run3', probedAt: '2026-08-16', aircraft: 0 }),
    ]) }),
]);
