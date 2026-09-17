import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// lib/feeds/portauthority.js does `import berthRegister from
// '../data/sample-lake/berths.json'` with no import attribute. Next's bundler
// resolves that natively; Node's own ESM loader wants `with { type: 'json' }`.
// Same inline loader hook as test/vessels.test.js, and for the same reason —
// the application source is not bent to suit the test runner.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

let extractRows, hasMovementTable, mapShipType, resolveBerth, parseScheduledMs, buildMovementCollection, fetchPortMovements;

before(async () => {
  ({ extractRows, hasMovementTable, mapShipType, resolveBerth, parseScheduledMs, buildMovementCollection, fetchPortMovements } =
    await import('../lib/feeds/portauthority.js'));
});

// Fixtures are hand-written, synthetic stand-ins for the two published
// movement pages. They reproduce only the table shape the parser keys off — the
// `view-*-table-column` header ids and `headers=` cells — with invented
// vessel and berth names, so the parser's behaviour is pinned without shipping
// the permissioned pages. Nothing here touches the network.
const FIXTURE_CAPTURED_MS = Date.parse('2026-08-14T05:00:00Z');
const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name) => readFileSync(`${fixtureDir}portauthority-${name}.html`, 'utf-8');

const SYDNEY_HARBOUR = {
  id: 'sydney-harbour',
  name: 'Sydney Harbour',
  url: 'https://www.portauthoritynsw.com.au/port-operations/sydney-harbour/sydney-harbour-daily-vessel-movements',
};
const PORT_BOTANY = {
  id: 'port-botany',
  name: 'Port Botany',
  url: 'https://www.portauthoritynsw.com.au/port-operations/port-botany/port-botany-daily-vessel-movements',
};

const SYDNEY_BBOX = { west: 150.4, south: -34.3, east: 151.7, north: -33.4 };

function livePages() {
  return [
    { port: SYDNEY_HARBOUR, url: SYDNEY_HARBOUR.url, html: fixture('sydney-harbour') },
    { port: PORT_BOTANY, url: PORT_BOTANY.url, html: fixture('port-botany') },
  ];
}

// A minimal page in the shape the extractor keys off: the header ids that mark
// the movements table, plus whatever rows a test wants.
function syntheticPage(rowsHtml, { withHeader = true } = {}) {
  const header = ['time', 'eta-bradleys', 'movement-type', 'vessel-name', 'vessel-type', 'vessel-agent', 'origin', 'destination', 'in-port']
    .map((column) => `<th id="view-${column}-table-column">${column}</th>`).join('');
  return `<html><body><table class="cols-9">${withHeader ? `<thead><tr>${header}</tr></thead>` : ''}<tbody>${rowsHtml}</tbody></table></body></html>`;
}

function syntheticRow(cells) {
  const tds = Object.entries(cells)
    .map(([column, value]) => `<td headers="view-${column}-table-column" class="views-field">${value}          </td>`)
    .join('\n');
  return `<tr>\n${tds}\n</tr>`;
}

const GOOD_ROW = {
  time: 'Fri 14 Aug<br>15:00',
  'eta-bradleys': 'N/A',
  'movement-type': '<span class="str-chip str-chip--departure">Departure</span>',
  'vessel-name': 'Aster Freighter',
  'vessel-type': 'Products Tanker',
  'vessel-agent': 'SYN',
  origin: 'Bulk Liquid Berth 1 (BLB1)',
  destination: 'Port Haven',
  'in-port': '<span class="str-chip str-chip--yes">Yes</span>',
};

// --- parsing real rows -----------------------------------------------------

test('the Sydney Harbour fixture parses into rows keyed by column, not by position', () => {
  const rows = extractRows(fixture('sydney-harbour'));
  assert.equal(rows.length, 12);
  // The date and time straddle a <br>, and the movement type and in-port flag
  // are wrapped in <span class="str-chip">; all three have to come out as
  // plain text.
  assert.deepEqual(rows[0], {
    time: 'Fri 14 Aug 06:00',
    'eta-bradleys': '06:40',
    'movement-type': 'Arrival',
    'vessel-name': 'Tidal Reach',
    'vessel-type': 'Passenger/Cruise',
    'vessel-agent': 'AEG',
    origin: 'Coral Cay',
    destination: 'Overseas Passenger Terminal (SCPT)',
    'in-port': 'No',
  });
});

test('the Port Botany fixture parses every row on the (unpaginated) view', () => {
  const rows = extractRows(fixture('port-botany'));
  assert.equal(rows.length, 14);
  assert.equal(rows[0]['vessel-name'], 'Aurora Tide');
  assert.equal(rows[0].origin, 'Bulk Liquids Berth 1 (BLB1)');
  assert.equal(rows[0]['in-port'], 'Yes');
});

test('the header row yields no cells — it uses <th id>, not <td headers>', () => {
  const rows = extractRows(syntheticPage(''));
  assert.deepEqual(rows, []);
});

test('a column inserted upstream does not shift every field one to the left', () => {
  // The whole point of keying off the `headers` attribute. An extra column
  // appears; the named fields still land in the right place.
  const withExtra = syntheticRow({ ...GOOD_ROW, 'pilot-boarding-ground': 'Eastern Channel' });
  const [row] = extractRows(syntheticPage(withExtra));
  assert.equal(row['vessel-name'], 'Aster Freighter');
  assert.equal(row.origin, 'Bulk Liquid Berth 1 (BLB1)');
  assert.equal(row['pilot-boarding-ground'], 'Eastern Channel');
});

test('hasMovementTable distinguishes a redesigned page from an empty one', () => {
  assert.equal(hasMovementTable(fixture('sydney-harbour')), true);
  assert.equal(hasMovementTable(syntheticPage('')), true);
  assert.equal(hasMovementTable('<html><body><p>Page not found</p></body></html>'), false);
});

// --- ship type -------------------------------------------------------------

test('every vessel type maps onto the lib/layers.js vocabulary', () => {
  // The vessel-type vocabulary the parser maps onto VESSEL_TYPES.
  assert.equal(mapShipType('Container Ship (Fully Cellular)'), 'cargo');
  assert.equal(mapShipType('Cement Carrier'), 'cargo');
  assert.equal(mapShipType('Products Tanker'), 'tanker');
  assert.equal(mapShipType('Chemical/Products Tanker'), 'tanker');
  assert.equal(mapShipType('Crude/Oil Products Tanker'), 'tanker');
  assert.equal(mapShipType('LPG Tanker'), 'tanker');
  assert.equal(mapShipType('Tanker (unspecified)'), 'tanker');
  assert.equal(mapShipType('Passenger/Cruise'), 'cruise');
  // A combination carrier: tanker before bulk carrier, which is what the rule
  // ordering exists to guarantee.
  assert.equal(mapShipType('Bulk/Oil/Chemical Carrier (CLEANBU)'), 'tanker');
});

test('ship type falls back to unknown rather than guessing', () => {
  assert.equal(mapShipType('Research Vessel'), 'unknown');
  assert.equal(mapShipType(''), 'unknown');
  assert.equal(mapShipType(null), 'unknown');
});

test('a plain passenger vessel is a ferry, not a cruise ship', () => {
  assert.equal(mapShipType('Passenger Ferry'), 'passenger');
  assert.equal(mapShipType('Cruise Ship'), 'cruise');
});

// --- berth resolution: hits ------------------------------------------------

test('berth resolution joins on the parenthetical code, which is the reliable key', () => {
  const resolved = resolveBerth('10 Brotherson Dock (BD10)');
  assert.equal(resolved.berth.id, 'brotherson-dock-10');
  assert.equal(resolved.match, 'code');
  assert.equal(resolveBerth('Kurnell 1 (KUR1)').berth.id, 'kurnell-1');
  assert.equal(resolveBerth('Bulk Liquid Berth 1 (BLB1)').berth.id, 'bulk-liquids-berth-1');
  assert.equal(resolveBerth('Hayes Dock 2 (HD2)').berth.id, 'hayes-dock-2');
  assert.equal(resolveBerth('Gore Cove 2 (GOR2)').berth.id, 'gore-cove-2');
});

test('a code the register holds only at terminal level resolves through the alias', () => {
  // The Authority disagrees with itself: its berths-and-facilities page calls
  // these OPT and WBCT, the movements feed calls them SCPT and WHT5.
  assert.equal(resolveBerth('Overseas Passenger Terminal (SCPT)').berth.id, 'opt');
  assert.equal(resolveBerth('White Bay Cruise Terminal (WHT5)').berth.id, 'white-bay');
});

test('berth resolution falls back to token overlap when there is no code', () => {
  const resolved = resolveBerth('Overseas Passenger Terminal');
  assert.equal(resolved.berth.id, 'opt');
  // Reported as a name match, because a name match is coarser than a code one.
  assert.equal(resolved.match, 'name');
});

test('token overlap ignores stop-words and pluralisation', () => {
  // "Wharf" carries no information; "Liquid" and "Liquids" are one word here.
  assert.equal(resolveBerth('Circular Quay Wharf 3').berth.id, 'cq-3');
  assert.equal(resolveBerth('Bulk Liquids Berth 2 (BLB2)').berth.id, 'bulk-liquids-berth-2');
});

test('the whole live berth vocabulary resolves — 13 distinct strings, all by code', () => {
  const berths = new Set();
  for (const page of livePages()) {
    for (const row of extractRows(page.html)) {
      berths.add(row['movement-type'] === 'Arrival' ? row.destination : row.origin);
    }
  }
  assert.equal(berths.size, 13);
  for (const berth of berths) {
    const resolved = resolveBerth(berth);
    assert.ok(resolved, `expected to resolve ${berth}`);
    assert.equal(resolved.match, 'code', `${berth} should join on its berth code`);
  }
});

// --- berth resolution: misses ----------------------------------------------

test('berth resolution returns null rather than putting a vessel on the wrong wharf', () => {
  // The register has no GLB3. "Glebe Island Berth 1-2" is the right precinct
  // and the wrong berth, so the number guard rejects it — an unplaced vessel is
  // honest, a vessel 200m up the quay from where it is is not.
  assert.equal(resolveBerth('Glebe Island 3 (GLB3)'), null);
});

test('an ambiguous name resolves to null rather than picking a winner', () => {
  // "Glebe Island" alone fits several register entries equally well. Nothing in
  // the source chooses between them, so neither does the resolver.
  assert.equal(resolveBerth('Glebe Island'), null);
});

test('an unknown berth, an unknown code and an empty string all resolve to null', () => {
  assert.equal(resolveBerth('Nowhere Special (ZZZ9)'), null);
  assert.equal(resolveBerth('Port Kembla No 4 Berth'), null);
  assert.equal(resolveBerth(''), null);
  assert.equal(resolveBerth(null), null);
});

test('unresolved berths are reported in the payload, not silently dropped', () => {
  const page = syntheticPage([
    syntheticRow({ ...GOOD_ROW, 'vessel-name': 'Placed Ship' }),
    syntheticRow({ ...GOOD_ROW, 'vessel-name': 'Lost Ship', origin: 'Glebe Island 3 (GLB3)' }),
  ].join('\n'));

  const collection = buildMovementCollection(
    [{ port: PORT_BOTANY, url: PORT_BOTANY.url, html: page }], null, { now: FIXTURE_CAPTURED_MS },
  );

  assert.equal(collection.features.length, 1);
  assert.equal(collection.features[0].properties.title, 'Placed Ship');
  assert.deepEqual(collection.unresolved_berths, [
    { berth: 'Glebe Island 3 (GLB3)', port: 'Port Botany', vessels: 1 },
  ]);
  assert.equal(collection.parsed.berths_unresolved, 1);
});

// --- scheduled time --------------------------------------------------------

test('a row time is read as Sydney local, not UTC', () => {
  // 14 Aug is AEST (+10): 15:00 Sydney is 05:00Z. Reading it as UTC would put
  // the movement ten hours out.
  assert.equal(parseScheduledMs('Fri 14 Aug 15:00', FIXTURE_CAPTURED_MS), Date.parse('2026-08-14T05:00:00Z'));
});

test('daylight saving is taken from the timezone database, not assumed', () => {
  // 15 Jan is AEDT (+11), so 15:00 Sydney is 04:00Z — an hour different from
  // the same wall time in August. A hardcoded +10 gets this wrong for five
  // months of the year.
  const january = Date.parse('2027-01-10T00:00:00Z');
  assert.equal(parseScheduledMs('Fri 15 Jan 15:00', january), Date.parse('2027-01-15T04:00:00Z'));
});

test('the missing year is inferred from the row\'s own weekday across a New Year boundary', () => {
  // Read on 30 Dec 2026, "Fri 01 Jan" can only be 2027 — 1 Jan 2026 was a
  // Thursday. Proximity alone would also get this one, but the weekday is what
  // makes it certain.
  const readOn = Date.parse('2026-12-30T00:00:00Z');
  const ms = parseScheduledMs('Fri 01 Jan 06:00', readOn);
  assert.equal(new Date(ms).getUTCFullYear(), 2026);          // 06:00 AEDT on 1 Jan 2027
  assert.equal(ms, Date.parse('2026-12-31T19:00:00Z'));
});

test('an impossible or unreadable date is null, not a silently shifted one', () => {
  assert.equal(parseScheduledMs('Wed 31 Apr 09:00', FIXTURE_CAPTURED_MS), null);   // must not roll into May
  assert.equal(parseScheduledMs('Mon 17 Foo 07:00', FIXTURE_CAPTURED_MS), null);
  assert.equal(parseScheduledMs('N/A', FIXTURE_CAPTURED_MS), null);
  assert.equal(parseScheduledMs('', FIXTURE_CAPTURED_MS), null);
});

// --- malformed rows --------------------------------------------------------

test('malformed rows are skipped and counted, never thrown', () => {
  const page = syntheticPage([
    syntheticRow(GOOD_ROW),
    syntheticRow({ ...GOOD_ROW, 'vessel-name': '' }),                              // no vessel
    syntheticRow({ ...GOOD_ROW, time: 'sometime next week' }),                     // unreadable time
    syntheticRow({ ...GOOD_ROW, 'movement-type': 'Loitering' }),                   // unknown movement
    syntheticRow({ ...GOOD_ROW, origin: '' }),                                     // departure with no berth
    syntheticRow({ time: 'Fri 14 Aug<br>15:00' }),                                 // a stub row
  ].join('\n'));

  const collection = buildMovementCollection(
    [{ port: PORT_BOTANY, url: PORT_BOTANY.url, html: page }], null, { now: FIXTURE_CAPTURED_MS },
  );

  assert.equal(collection.parsed.rows_seen, 6);
  assert.equal(collection.parsed.rows_skipped, 5);
  assert.equal(collection.features.length, 1);
  assert.equal(collection.features[0].properties.title, 'Aster Freighter');
});

// --- loud failure ----------------------------------------------------------

test('a redesigned page throws instead of quietly serving nothing', () => {
  // The failure this feed most needs to survive. An empty list here would look
  // exactly like a quiet day at the wharf and nobody would notice for weeks.
  assert.throws(
    () => buildMovementCollection(
      [{ port: PORT_BOTANY, url: PORT_BOTANY.url, html: '<html><body><h1>Vessel movements</h1></body></html>' }],
      null, { now: FIXTURE_CAPTURED_MS },
    ),
    /page structure has changed/,
  );
});

test('a movement table that renders with no rows throws', () => {
  assert.throws(
    () => buildMovementCollection(
      [{ port: PORT_BOTANY, url: PORT_BOTANY.url, html: syntheticPage('') }], null, { now: FIXTURE_CAPTURED_MS },
    ),
    /no rows/,
  );
});

test('rows that all fail to parse throw — a changed column layout is not an empty port', () => {
  const page = syntheticPage([
    syntheticRow({ ...GOOD_ROW, time: 'no idea', 'vessel-name': 'Ship A' }),
    syntheticRow({ ...GOOD_ROW, time: 'no idea', 'vessel-name': 'Ship B' }),
  ].join('\n'));
  assert.throws(
    () => buildMovementCollection([{ port: PORT_BOTANY, url: PORT_BOTANY.url, html: page }], null, { now: FIXTURE_CAPTURED_MS }),
    /all 2 rows failed to parse/,
  );
});

test('no pages at all is empty, not an error — nothing was fetched to fail', () => {
  const collection = buildMovementCollection([], null, { now: FIXTURE_CAPTURED_MS });
  assert.deepEqual(collection.features, []);
});

// --- the assembled collection ----------------------------------------------

test('the live fixtures produce a GeoJSON FeatureCollection on the vessels layer', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });

  assert.equal(collection.type, 'FeatureCollection');
  assert.ok(collection.features.length > 0);
  for (const feature of collection.features) {
    assert.equal(feature.properties.layer, 'vessels');
    assert.equal(feature.properties.source, 'portauthority');
    // The position was read off the berth register, not off the vessel. This
    // has to survive to the UI, so it is pinned here.
    assert.equal(feature.properties.position_source, 'berth');
    assert.ok(feature.properties.berth_id);
  }
});

test('coordinates come out in GeoJSON order: [lon, lat]', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });
  for (const feature of collection.features) {
    const [lon, lat] = feature.geometry.coordinates;
    assert.ok(lon > 150 && lon < 152, `longitude should be ~151, got ${lon}`);
    assert.ok(lat > -35 && lat < -33, `latitude should be ~-33.9, got ${lat}`);
  }
});

test('a vessel in port is placed at the berth it is alongside, not the one it is sailing for', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });
  const aurora = collection.features.find((f) => f.properties.title === 'Aurora Tide');

  // Its only row is a DEPARTURE from BLB1 to Northreach, flagged in port. The
  // berth is the origin; Northreach is where it is going.
  assert.equal(aurora.properties.berth_id, 'bulk-liquids-berth-1');
  assert.equal(aurora.properties.destination, 'Northreach');
  assert.equal(aurora.properties.in_port, true);
  assert.equal(aurora.properties.movement, 'in_port');
  assert.equal(aurora.properties.scheduled_movement, 'departure');
  assert.equal(aurora.properties.ship_type, 'tanker');
  assert.equal(aurora.properties.agent, 'AEG');
});

test('an arriving vessel is placed at its destination berth, not its last port of call', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });
  const cape = collection.features.find((f) => f.properties.title === 'Cape Meridian');

  assert.equal(cape.properties.movement, 'arrival');
  assert.equal(cape.properties.origin, 'Northreach');
  assert.equal(cape.properties.berth_id, 'bulk-liquids-berth-1');
});

test('a vessel listed on several movements yields one feature, with the row count kept', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });
  const titles = collection.features.map((f) => f.properties.title);
  assert.equal(new Set(titles).size, titles.length, 'one feature per hull');

  // Cape Meridian appears four times on the Port Botany page (two calls, each
  // an arrival and a departure).
  const cape = collection.features.find((f) => f.properties.title === 'Cape Meridian');
  assert.equal(cape.properties.movements_listed, 4);
});

test('movements too far out to place a hull at a berth are counted, not drawn', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });
  assert.ok(collection.parsed.beyond_horizon > 0);
  assert.equal(
    collection.parsed.vessels,
    collection.features.length + collection.parsed.beyond_horizon + collection.parsed.berths_unresolved,
  );
});

test('the collection is clipped to the region bbox', () => {
  // A bbox around Sydney Harbour proper excludes Port Botany at ~-33.97.
  const harbourOnly = { bbox: { west: 151.15, east: 151.30, south: -33.90, north: -33.75 } };
  const collection = buildMovementCollection(livePages(), harbourOnly, { now: FIXTURE_CAPTURED_MS });

  assert.ok(collection.parsed.outside_region > 0, 'expected Port Botany berths to be clipped away');
  for (const feature of collection.features) {
    assert.ok(feature.geometry.coordinates[1] > -33.90);
  }
});

// --- standing down --------------------------------------------------------

test('fetchPortMovements stands down instead of scraping, and says why', async () => {
  // Three guards apply here, and inside `node --test` the first of them always
  // fires: this suite must not generate traffic to the Authority's server. The
  // no-region case is asserted because it is the one a caller can reach in
  // production — lib/feeds/vessels.js calls fetchVessels() with no region.
  for (const region of [undefined, { bbox: { west: 148.7, east: 149.4, south: -35.6, north: -35.1 } }]) {
    const collection = await fetchPortMovements(region);
    assert.deepEqual(collection.features, []);
    assert.equal(collection.source, 'portauthority');
    assert.ok(collection.notice, 'an empty collection must explain itself');
  }
});

test('attribution rides on the payload', () => {
  const collection = buildMovementCollection(livePages(), { bbox: SYDNEY_BBOX }, { now: FIXTURE_CAPTURED_MS });
  assert.equal(collection.rights.copyright, 'Port Authority of NSW');
  assert.match(collection.rights.source_url, /^https:\/\/www\.portauthoritynsw\.com\.au\//);
  assert.equal(collection.rights.source_urls.length, 2);
});

// --- registry without the Port Authority module ---------------------------

test('the vessels feed builds and runs without the Port Authority feed', async () => {
  // `includePortAuthority: false` simulates the permissioned portauthority.js
  // module being excluded from the public tree. The vessels layer must still
  // build and serve its other sources, and must not reach for the port source.
  const { fetchVessels } = await import('../lib/feeds/vessels.js');
  let portReached = false;
  const fc = await fetchVessels(null, {
    stored: async () => [],
    ferries: async () => [{
      mmsi: 'SYNTH-1', name: 'SYNTHETIC FERRY', ship_type: 'passenger',
      position: [151.2401, -33.8501], speed_over_ground_knots: 12,
      course_over_ground_degrees: 45, last_report_ms: Date.now(), feed_source: 'tfnsw',
    }],
    portMovements: async () => { portReached = true; return { features: [] }; },
    includePortAuthority: false,
  });
  assert.equal(portReached, false, 'a disabled port feed must not be reached');
  assert.equal(fc.features.length, 1);
  assert.equal(fc.source, 'tfnsw');
});
