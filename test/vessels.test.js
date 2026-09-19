import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The vessels feed reaches lib/data/sample-lake/berths.json through the Port
// Authority source, which imports it without an import attribute. Next's
// bundler resolves bare JSON imports natively; Node's own ESM loader requires
// `with { type: 'json' }` and throws ERR_IMPORT_ATTRIBUTE_MISSING otherwise.
// Rather than change application source to suit the test runner, this registers
// a process-scoped loader hook that supplies the attribute. Inline as a data:
// URL so it needs no file of its own — any .js under test/ would be picked up
// by `node --test` as though it were a test file.
const jsonImportShim = `
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.json') && (!context.importAttributes || context.importAttributes.type !== 'json')) {
      return nextLoad(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
    }
    return nextLoad(url, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(jsonImportShim)}`, import.meta.url);

let fetchVessels;
let toFeature;

before(async () => {
  ({ fetchVessels, toFeature } = await import('../lib/feeds/vessels.js'));
});

// The bundled sample fallback was removed when aisstream was dropped: with two
// real sources there is no case for drawing invented ships. So these tests
// inject fakes rather than leaning on a fixture the feed no longer carries,
// which also means they never touch the network or a database.

const ferry = (over = {}) => ({
  mmsi: 'TFNSW-Freshwater',
  name: 'FRESHWATER',
  ship_type: 'passenger',
  position: [151.2401, -33.8501],
  speed_over_ground_knots: 12,
  course_over_ground_degrees: 45,
  last_report_ms: Date.now(),
  feed_source: 'tfnsw',
  ...over,
});

const noSources = {
  stored: async () => [],
  ferries: async () => [],
  // Stubbed for every case, not just the ones that assert on it: the global AIS
  // source is real and would otherwise be called over the network by any test
  // that passes a region with a bbox.
  openWaters: async () => [],
  portMovements: async () => ({ features: [] }),
};

test('coordinates come out in GeoJSON order: [lon, lat], not [lat, lon]', async () => {
  const fc = await fetchVessels(null, { ...noSources, ferries: async () => [ferry()] });
  assert.equal(fc.features.length, 1);
  const [lon, lat] = fc.features[0].geometry.coordinates;
  // Sydney sits near 151E, -33.8S. Reversing the order puts this point in the
  // Southern Ocean west of the mainland — the classic bug this pins.
  assert.ok(lon > 150 && lon < 152, `longitude should be ~151, got ${lon}`);
  assert.ok(lat > -35 && lat < -33, `latitude should be ~-33.8, got ${lat}`);
});

test('each vessel carries the source it actually came from', async () => {
  // The collection-level source names every contributing feed, but a single
  // vessel came from exactly one of them, and an operator inspecting a contact
  // needs to know which.
  const fc = await fetchVessels(null, {
    ...noSources,
    ferries: async () => [ferry()],
    portMovements: async () => ({
      features: [{
        geometry: { coordinates: [151.2193, -33.9693] },
        properties: { title: 'OOCL SHANGHAI', ship_type: 'cargo', berth: 'Brotherson Dock 10 (BD10)', scheduled_ms: Date.now() },
      }],
    }),
  });
  assert.equal(fc.features.length, 2);
  const bySource = Object.fromEntries(fc.features.map((f) => [f.properties.source, f.properties.title]));
  assert.equal(bySource.tfnsw, 'FRESHWATER');
  assert.equal(bySource.portauthority, 'OOCL SHANGHAI');
  assert.equal(fc.source, 'tfnsw+portauthority');
});

test('an empty layer says why, and names the real reason', async () => {
  // A notice that misstates its own cause trains an operator to stop reading
  // notices. With a TfNSW key present the honest answer is "nothing reported",
  // not "no key configured".
  const previous = process.env.TFNSW_API_KEY;
  process.env.TFNSW_API_KEY = 'present';
  try {
    const fc = await fetchVessels(null, noSources);
    assert.equal(fc.features.length, 0);
    assert.equal(fc.source, 'none');
    assert.match(fc.notice, /no vessels currently reported/i);
    assert.doesNotMatch(fc.notice, /key not configured/i);
  } finally {
    if (previous === undefined) delete process.env.TFNSW_API_KEY;
    else process.env.TFNSW_API_KEY = previous;
  }
});

test('a missing transport key is reported as the cause when it is the cause', async () => {
  const previous = process.env.TFNSW_API_KEY;
  delete process.env.TFNSW_API_KEY;
  try {
    const fc = await fetchVessels(null, noSources);
    assert.match(fc.notice, /Transport for NSW key is not configured/i);
  } finally {
    if (previous !== undefined) process.env.TFNSW_API_KEY = previous;
  }
});

test('every live source failing is an outage, not a live empty picture', async () => {
  // A total outage (all three sources throw) must not present as a fresh, live,
  // empty layer. The status strip reads liveness from `payload.live` and the
  // chip turns on `error`, so both have to be set — otherwise an operator sees
  // a green chip over a map with nothing on it and no hint that the feed is
  // down rather than quiet.
  const allDown = {
    stored: async () => { throw new Error('datastore unreachable'); },
    ferries: async () => { throw new Error('TfNSW 503'); },
    portMovements: async () => { throw new Error('port site redesigned'); },
  };
  const fc = await fetchVessels(null, allDown);
  assert.equal(fc.features.length, 0);
  assert.equal(fc.live, false);
  assert.match(fc.error, /all live sources failed/i);
  assert.match(fc.error, /tfnsw: TfNSW 503/i);
  assert.match(fc.error, /portauthority: port site redesigned/i);
});

test('stored failing while the live sources report nothing is not an outage', async () => {
  // `stored` is the datastore written by ingest. Its failing alone (or simply
  // writing nothing yet) is not a reason to flag the whole layer down — the
  // live feeds are the ones that carry the picture.
  const previous = process.env.TFNSW_API_KEY;
  process.env.TFNSW_API_KEY = 'present';
  try {
    const fc = await fetchVessels(null, {
      stored: async () => { throw new Error('db down'); },
      ferries: async () => [],
      portMovements: async () => ({ features: [] }),
    });
    assert.equal(fc.features.length, 0);
    assert.equal(fc.live, true);
    assert.equal(fc.error, undefined);
    assert.match(fc.notice, /no vessels currently reported/i);
  } finally {
    if (previous === undefined) delete process.env.TFNSW_API_KEY;
    else process.env.TFNSW_API_KEY = previous;
  }
});

test('one live source failing while another contributes is not an outage', async () => {
  const fc = await fetchVessels(null, {
    stored: async () => [],
    ferries: async () => [ferry()],
    portMovements: async () => { throw new Error('port site redesigned'); },
  });
  assert.equal(fc.features.length, 1);
  assert.equal(fc.live, true);
  assert.equal(fc.error, undefined);
});

test('a bbox filter excludes vessels outside it', async () => {
  // A bbox around the harbour mouth must exclude a vessel down at Port Botany,
  // roughly -33.97.
  const region = { bbox: { west: 151.15, east: 151.30, south: -33.87, north: -33.75 } };
  const fc = await fetchVessels(region, {
    ...noSources,
    ferries: async () => [
      ferry({ name: 'IN HARBOUR', position: [151.24, -33.85] }),
      ferry({ name: 'AT PORT BOTANY', mmsi: 'TFNSW-x', position: [151.22, -33.97] }),
    ],
  });
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.title, 'IN HARBOUR');
});

test('a source whose vessels are all outside the bbox is not named', async () => {
  // Every source answers every region: the NSW ferries come back for a Gulf
  // region too, and are then discarded by the bbox filter. Naming them anyway
  // put "tfnsw" on a region where no ferry is ever drawn.
  const region = { bbox: { west: 55.0, east: 57.5, south: 25.5, north: 27.6 } };
  const fc = await fetchVessels(region, {
    ...noSources,
    ferries: async () => [ferry({ position: [151.24, -33.85] })],
    openWaters: async () => [{
      mmsi: 999, name: 'GULF SHIP', ship_type: 'tanker',
      position: [56.2, 26.6], last_report_ms: Date.now(), feed_source: 'aishub',
    }],
  });
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].properties.title, 'GULF SHIP');
  assert.equal(fc.source, 'aishub');
});

test('one failing source does not cost the others', async () => {
  // Port movements are a courtesy scrape of a third-party site. If it breaks,
  // the ferry layer must still render.
  const fc = await fetchVessels(null, {
    ...noSources,
    ferries: async () => [ferry()],
    portMovements: async () => { throw new Error('port site redesigned'); },
  });
  assert.equal(fc.features.length, 1);
  assert.equal(fc.source, 'tfnsw');
});

test('toFeature marks a stale contact as not reporting', async () => {
  const now = Date.now();
  const fresh = toFeature({ ...ferry(), last_report_ms: now - 60_000 }, { source: 'tfnsw', now });
  const stale = toFeature({ ...ferry(), last_report_ms: now - 45 * 60_000 }, { source: 'tfnsw', now });
  assert.equal(fresh.properties.reporting, true);
  assert.equal(stale.properties.reporting, false, 'a 45-minute-old fix is not a current position');
});
