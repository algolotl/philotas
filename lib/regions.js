// Region definitions — the thing that makes Philotas "drop in a new city".
//
// A region declares its camera home, spatial filter (bbox), satellite observer
// (for the "overhead" filter), fixed sites, which layers are active, per-feed
// params, and its own demo arc. Feeds read these off the region, so re-aiming
// the whole picture is data, not code. `world` is the default: everything at
// once, globally; `canberra` is the full national-capital build.

import { CANBERRA, SITES, REGION_BBOX } from './config.js';
// A cycle: lib/region-catalogue.js imports `place` from this file, and this one
// imports the builder back.
//
// Two things make it safe, and BOTH are load-bearing. `buildCatalogueRegions` is
// a hoisted function declaration, so it is callable before its module body has
// run. And lib/region-catalogue.js lists its two acyclic imports — the probe
// artefact and the classifier — ahead of its import of this file, so those are
// fully evaluated before anything can call back into here.
//
// It is NOT safe because "nothing runs at body level": the REGIONS literal below
// is body-level and it calls the builder. That is precisely the hazard. Drop
// either condition and the call reaches a `const` still in the temporal dead
// zone — measured, both directions, see the comment on buildCatalogueRegions().
import { buildCatalogueRegions } from './region-catalogue.js';

// Every layer the Sydney flagship build carries. Vessels and berths are the
// maritime domain; transport is what ties it to the land network at Circular
// Quay, which is the whole point of the region.
const SYDNEY_LAYERS = [
  'aviation', 'satellites', 'vessels', 'berths', 'transport', 'cameras',
  'fires', 'hotspots', 'seismic', 'weather', 'news', 'facilities',
];

// The news catchment is a different question from the map view, and probe run 2
// (docs/measurements/2026-08-16-region-coverage-probe-run2.txt, committed
// be26a2d) settled it across all 64 candidates rather than by example. Scored
// against one 409-record GKG file on 2026-08-16: at the metro-sized default of
// 0.6 x 0.5 degrees the whole candidate set drew 91 records and 33 of 64
// candidates read zero. At 2.5 x 2.0 the same file drew 389 and only 12 read
// zero.
//
// GKG geocodes an article to the place it names, and shipping news about Le
// Havre is frequently filed against Rouen or Paris: Le Havre went 0 to 21,
// Dover 0 to 49, Haifa 0 to 21, Suez 0 to 16. Both measured points say wider
// is better, so the catchment is expressed as a multiple of each region's own
// map half-extent rather than one fixed box copied onto every candidate.
// NEWS_CATCHMENT_MULTIPLE = 3 puts the metro default's catchment at 1.8 x 1.5
// — an interpolation between the two measured points, closer to the 0.6 x 0.5
// end than the 2.5 x 2.0 one. 1.8 x 1.5 was NOT itself scored against the
// probe file; the probe only ran the two columns above. Articles are still
// drawn at their true coordinates, so some will sit outside the opening
// viewport, which is honest — the story is where the story is.
export const NEWS_CATCHMENT_MULTIPLE = 3;

// And the multiple applies at the scale it was measured at, which is metro
// scale and nothing else.
//
// Every one of the 64 candidates the probe scored is a city or a chokepoint,
// with a half-extent of [0.6, 0.5] or [1.2, 1.0]. A continental region's
// half-extent is one to two orders of magnitude larger, and nobody has ever
// scored a GKG file against one. Measured 2026-08-17 by applying the same 3x to
// the shipped `country` and `region` rows, it does not extrapolate: at
// unitedstates' half of [30, 16] the catchment ran lon -188..-8, lat -9..87,
// which contains Mexico City [-99.1, 19.4], Bogota [-74.0, 4.7] and Nuuk
// [-51.7, 64.2] — none of which are inside the map bbox of lon -128..-68,
// lat 23..55. lib/feeds/news.js serves the 60 NEWEST records inside the box, so
// a continental view could be filled by the newest stories from a neighbouring
// continent regardless of whether any of them were American.
//
// A second multiplier for continental regions would be the same mistake with a
// different number: there is exactly one measured basis here and it is metro
// scale. So the wide views take their own map bbox as their catchment, which is
// already 60 degrees of longitude and needs no help finding stories filed next
// door. That restores what these three regions filtered on before the widening,
// and it also stops the multiple compounding southpacific's bbox.east = 190 —
// a pre-existing invalid longitude that `inside()` in lib/corpus/news-store.js
// cannot match past 180 either way, left alone here rather than fixed in
// passing.
export const NEWS_CATCHMENT_TYPES = Object.freeze(['city', 'strait']);

// Latitude only. A bounding box with north > 90 is not a place. Longitude is
// left unclamped deliberately: `inside()` in lib/corpus/news-store.js is a
// plain comparison, so a catchment running past +/-180 stops matching there
// rather than wrapping, and clamping it would break the guarantee that a
// catchment contains its own map box.
//
// While the multiple was applied to the continental regions too, three
// catchments ran past the antimeridian — measured 2026-08-16, australia
// [68, 200], unitedstates [-188, -8], southpacific [90, 240]. Confining the
// multiple to metro scale took all three back to their own map bbox. Measured
// 2026-08-17 across the 80 shipped catchments, exactly one still runs past
// +/-180: southpacific, at [140, 190], which is its map bbox and was already
// that before any of this. `inside()` cannot match anything east of 180
// whichever box asks, so that longitude is unreachable in the same way it
// always was — a pre-existing gap for whoever decides whether `inside()` should
// wrap, not something the catchment created.
const clampLatitude = (degrees) => Math.max(-90, Math.min(90, degrees));

// Theatre, because 83 regions is not a dropdown. `REGION_LIST` carries it so the
// picker can group without knowing anything about geography, and the order here
// is the order the groups appear in. `Global` first, so the whole-earth view
// stays at the top of the list where it has always been.
export const THEATRES = Object.freeze([
  'Global',
  'Australia & NZ',
  'United States',
  'Europe',
  'Middle East',
  'North East Asia',
  'South East Asia',
]);

// The permitted `type` vocabulary, exported so it has exactly one definition.
// `world` is never passed through `place()` — it belongs only to the
// hand-written `world` region — but it is still a value a region can
// legitimately carry, so it stays in the set REGION_LIST and the schema tests
// validate against. Tasks 5 and 7 filter on the literal string `'strait'` for
// the incoming chokepoint regions; this is what a typo there fails against.
export const REGION_TYPES = Object.freeze(['world', 'country', 'region', 'city', 'strait']);

// Factory for a region built only from the globally-capable sources — so any
// city/country/region/strait works without bespoke feed wiring: aviation,
// satellites, seismic, news and natural events (+ BoM weather if a product
// URL is supplied). `type` is one of 'city' | 'country' | 'region' | 'strait'
// — 'world' is reserved for the hand-written `world` region and never passed
// here. `theatre` is a passthrough here; it groups regions for the
// coverage-expansion work without this function needing to know the set of
// valid values.
export function place({ id, name, type = 'city', country, theatre, center, half = [0.6, 0.5], newsHalf, zoom = 9.5, observer = true, weatherUrl, sites = [], adsbCoverage }) {
  const bbox = { west: center[0] - half[0], east: center[0] + half[0], south: center[1] - half[1], north: center[1] + half[1] };
  // Metro scale gets the measured multiple; a continental view is already wide
  // enough to be its own catchment. See NEWS_CATCHMENT_TYPES above for why
  // there is no second multiplier for the wide types.
  const widened = NEWS_CATCHMENT_TYPES.includes(type)
    ? [half[0] * NEWS_CATCHMENT_MULTIPLE, half[1] * NEWS_CATCHMENT_MULTIPLE]
    : half;
  const catchment = newsHalf || widened;
  const newsBbox = {
    west: center[0] - catchment[0],
    east: center[0] + catchment[0],
    south: clampLatitude(center[1] - catchment[1]),
    north: clampLatitude(center[1] + catchment[1]),
  };
  // hotspots is global: NASA FIRMS takes any bounding box and one MAP_KEY
  // covers the world. vessels is global now too, since the layer gained a
  // keyless worldwide AIS source (lib/feeds/openwaters-ais.js) — transport,
  // cameras and facilities are the ones that still need a national integration
  // and stay Sydney-only.
  const layers = ['aviation', 'satellites', 'vessels', 'seismic', 'hotspots', 'news', 'events'];
  const params = {
    // Aviation catchment, in nautical miles, independent of the map bounding
    // box. The radius was previously derived from the bbox, which for a
    // metro-sized region worked out at 37 nm and returned 22 aircraft over
    // London. adsb.fi is a volunteer feeder network and its coverage, not our
    // radius, is the real ceiling — measured over London: 22 at 37 nm, 33 at
    // 100 nm, 85 at 250 nm. 150 nm is the compromise: roughly triple the
    // contacts without scattering them so far from the region that the map
    // view is mostly empty space.
    aviation: {
      radiusNm: 150,
      // The verdict AND the readings behind it, never one without the other.
      //
      // adsb.fi is a volunteer feeder network, and over mainland China and the
      // Russian Far East a reading of zero means no feeder is in range rather
      // than that the sky is empty. Nothing in a single response distinguishes
      // those, and nothing in a single RUN does either: probe run 1 read Ningbo
      // at 0 aircraft and run 2 read it at 1, both on 2026-08-16. A build that
      // had shipped run 1's answer would have published a false claim about a
      // working port. So the state is derived from agreement across runs by
      // lib/adsb-coverage.js, and the readings travel with it so the layer can
      // show the numbers instead of only the verdict.
      ...(adsbCoverage ? { coverage: adsbCoverage } : {}),
    },
    // Nearest-to-overhead first, so a cap trims the horizon rather than the
    // interesting part of the sky. About 940 objects sit above a given horizon
    // once the full catalogue is tracked; 400 is dense without being a wall.
    satellites: { cap: 400 },
  };
  if (weatherUrl) { layers.push('weather'); params.weather = { url: weatherUrl }; }
  // A chokepoint is a waterway, and the arc should not open on it as though it
  // had a downtown. Two steps carry a description of the place; the rest describe
  // a layer and read the same either way.
  //
  // Suez and the Kiel Canal are canals rather than straits. They carry the same
  // type because the distinction changes nothing about how they are viewed or
  // grouped, and a tenth type nobody filters on is not worth the branch.
  const isChokepoint = type === 'strait';
  const opening = isChokepoint
    ? `Open on the ${name} chokepoint — air, orbit, seismic and news over the waterway in one frame.`
    : `Open on ${name} — air, orbit, seismic and news in one frame.`;
  const coverage = isChokepoint
    ? `Coverage of shipping and incidents through the ${name}.`
    : `Coverage mentioning ${name}.`;
  return {
    id, name, type, country, theatre, center, zoom, bbox, newsBbox, observer: observer ? center : null, sites, layers, params,
    arc: [
      { title: `1 · ${name}`, body: opening, layers: 'all', target: { home: true, zoom } },
      { title: '2 · Air traffic', body: 'Live aircraft over the area.', layers: ['aviation'], target: { home: true, zoom: Math.max(zoom, 10) } },
      { title: '3 · Overhead', body: 'Satellites currently above the horizon.', layers: ['satellites'], target: { home: true, zoom: Math.max(2, zoom - 3) } },
      { title: '4 · In the news', body: coverage, layers: ['news'], target: { home: true, zoom } },
      { title: '5 · Full picture', body: 'All layers on, resolved by the ontology pass.', layers: 'all', target: { home: true, zoom } },
    ],
  };
}

export const REGIONS = {
  world: {
    id: 'world',
    name: 'Worldwide',
    type: 'world',
    theatre: 'Global',
    center: [12, 22],
    zoom: 1.6,
    bbox: null,        // no spatial filter
    observer: null,    // satellites: show the whole orbital scatter, no horizon filter
    sites: [],
    // Globally-capable feeds + the EONET natural-events API connector.
    layers: ['aviation', 'satellites', 'seismic', 'news', 'events'],
    params: {
      // The only region without a bbox. OpenSky is bring-your-own-credentials
      // and opt-in, so the world view defaults to adsb.fi; without OpenSky
      // enabled the layer reports the opt-in reason (adsb.fi has no global
      // feed). When OpenSky IS enabled, a global query costs 4 credits against
      // a 4,000/day standard account; 120s gives ~720 calls/day (~2,880
      // credits) and leaves headroom. See lib/feeds/aviation.js.
      aviation: { cap: 1500, ttl: 120_000 },
      satellites: { cap: 1000 },
      // The world's curated topical filter, an OR-list of topics. The world has
      // no bbox, so lib/feeds/news.js narrows the whole window to stories on
      // these topics. OR-only: an AND-composite would collapse into one
      // un-matchable literal term, so every configured query must be an
      // OR-list.
      news: { query: '(earthquake OR election OR conflict OR flood OR wildfire OR summit OR protest)' },
    },
    arc: [
      { title: '1 · The whole earth', body: 'Every globally-capable feed at once — air, orbit, seismic, news.', layers: 'all', target: { home: true, zoom: 1.6 } },
      { title: '2 · Live air traffic', body: 'Thousands of aircraft aloft right now. Pull a busy corridor.', layers: ['aviation'], target: { center: [10, 50], zoom: 4 } },
      { title: '3 · The orbital shell', body: 'Visible satellites + stations, propagated from live orbital elements.', layers: ['satellites'], target: { home: true, zoom: 1.6 } },
      { title: '4 · The earth shaking', body: 'Every earthquake in the last 24 hours, worldwide.', layers: ['seismic'], target: { home: true, zoom: 1.6 } },
      { title: '5 · The world in the news', body: 'Coverage placed where the story is, filtered to the world\'s key topics.', layers: ['news'], target: { home: true, zoom: 1.6 } },
      { title: '6 · One picture', body: 'All world layers on, resolved by the ontology pass.', layers: 'all', target: { home: true, zoom: 1.6 } },
    ],
  },

  // The flagship build. Sydney is where the maritime domain and the city's
  // transport network physically touch: a ship berths at Circular Quay, the
  // ferry wharves back up, the station loads. That chain across domains is the
  // job the ontology exists to do.
  sydney: {
    id: 'sydney',
    name: 'Sydney',
    type: 'city', country: 'AU', theatre: 'Australia & NZ',
    center: [151.2280, -33.8560], // Harbour, between the Heads and the Quay
    zoom: 11.5,
    bbox: { west: 150.4, south: -34.3, east: 151.7, north: -33.4 },
    observer: [151.2093, -33.8688],
    sites: [
      { id: 'circularquay', name: 'Circular Quay', kind: 'port', coord: [151.2110, -33.8610] },
      { id: 'opt', name: 'Overseas Passenger Terminal', kind: 'port', coord: [151.2085, -33.8587] },
      { id: 'portbotany', name: 'Port Botany', kind: 'port', coord: [151.2300, -33.9700] },
      { id: 'gardenisland', name: 'Garden Island (RAN Fleet Base East)', kind: 'defence', coord: [151.2310, -33.8660] },
      { id: 'sydneyheads', name: 'Sydney Heads', kind: 'landmark', coord: [151.2820, -33.8280] },
      { id: 'yssy', name: 'Sydney Airport (YSSY)', kind: 'airfield', coord: [151.1770, -33.9460] },
      { id: 'cbd', name: 'Sydney CBD / Opera House', kind: 'gov', coord: [151.2150, -33.8570] },
    ],
    layers: SYDNEY_LAYERS,
    params: {
      weather: { url: 'https://www.bom.gov.au/fwo/IDN60901/IDN60901.94768.json' }, // Observatory Hill
      // Keyed via TFNSW_API_KEY. Modes with no key are skipped individually, so
      // a missing key costs you that mode rather than the whole layer.
      transport: { sources: ['ferries', 'sydneytrains', 'buses', 'lightrail', 'metro'] },
    },
    arc: [
      { title: '1 · The harbour', body: 'Open on Sydney Harbour — vessels, ferries, trains and buses moving in one frame.', layers: 'all', target: { home: true, zoom: 11.5 } },
      { title: '2 · Circular Quay', body: 'Where the sea meets the city. A ship berths, the wharves fill, the station loads.', layers: ['vessels', 'berths', 'transport'], target: { siteId: 'circularquay', zoom: 14 } },
      { title: '3 · Port Botany', body: 'Container and bulk-liquid terminals — the freight half of the picture.', layers: ['vessels', 'berths'], target: { siteId: 'portbotany', zoom: 13 } },
      { title: '4 · The approaches', body: 'Traffic through Sydney Heads, and what is standing off the coast.', layers: ['vessels'], target: { siteId: 'sydneyheads', zoom: 11 } },
      { title: '5 · Kingsford Smith', body: 'Pull the YSSY approach — one of the busiest corridors in the country.', layers: ['aviation'], target: { siteId: 'yssy', zoom: 11 } },
      { title: '6 · Overhead', body: 'Satellites currently above the Sydney horizon, from live orbital elements.', layers: ['satellites'], target: { home: true, zoom: 7 } },
      { title: '7 · Full picture', body: 'Every Sydney layer on, resolved by the ontology pass.', layers: 'all', target: { home: true, zoom: 11 } },
    ],
  },

  // Canberra keeps the Deep Space Network because Tidbinbilla is genuinely
  // there, and CDSCC supplies the ontology's only structural (non-LLM) links:
  // ground station tracks spacecraft, spacecraft is the same as a tracked
  // satellite. Losing it would leave the ontology demonstrating LLM-adjudicated
  // links alone, which undercuts the auditability argument. The ACT-only
  // transport, cameras and cafe layers are gone.
  canberra: {
    id: 'canberra',
    name: 'Canberra',
    type: 'city', country: 'AU', theatre: 'Australia & NZ',
    center: CANBERRA.center,
    zoom: CANBERRA.defaultZoom,
    bbox: REGION_BBOX,
    observer: CANBERRA.center,
    sites: SITES,
    layers: ['aviation', 'satellites', 'space', 'fires', 'seismic', 'weather', 'news', 'facilities'],
    params: {
      weather: { url: 'https://www.bom.gov.au/fwo/IDN60903/IDN60903.94926.json' }, // Canberra Airport
    },
    arc: [
      { title: '1 · The capital', body: 'Open on Canberra — air, orbit, deep space, fire and news in one frame.', layers: 'all', target: { home: true, zoom: 9.5 } },
      { title: '2 · Tidbinbilla', body: 'Swing to CDSCC — the deep-space dishes tracking a probe right now.', layers: ['space'], target: { siteId: 'cdscc', zoom: 12 } },
      { title: '3 · Structural links', body: 'Dish tracks spacecraft; spacecraft matches a tracked satellite. Resolved without a model.', layers: ['space', 'satellites'], target: { siteId: 'cdscc', zoom: 8 } },
      { title: '4 · Fairbairn movement', body: 'Pull the approach. RAAF Fairbairn shares YSCB — 34 SQN VIP traffic, with trails.', layers: ['aviation'], target: { siteId: 'yscb', zoom: 11 } },
      { title: '5 · Full picture', body: 'All layers on, resolved by the ontology pass.', layers: 'all', target: { home: true, zoom: 9 } },
    ],
  },

  // ---- world cities (reusable-source factory) ----
  melbourne: place({ id: 'melbourne', name: 'Melbourne', country: 'AU', theatre: 'Australia & NZ', center: [144.9631, -37.8136], zoom: 9.5,
    weatherUrl: 'https://www.bom.gov.au/fwo/IDV60901/IDV60901.95936.json',
    sites: [{ id: 'cbd', name: 'Melbourne CBD', kind: 'gov', coord: [144.9631, -37.8136] }, { id: 'ymml', name: 'Melbourne Airport (YMML)', kind: 'airfield', coord: [144.843, -37.673] }] }),
  sanfrancisco: place({ id: 'sanfrancisco', name: 'San Francisco', country: 'US', theatre: 'United States', center: [-122.4194, 37.7749], zoom: 10,
    sites: [{ id: 'sfo', name: 'San Francisco Intl (SFO)', kind: 'airfield', coord: [-122.379, 37.621] }, { id: 'ggb', name: 'Golden Gate Bridge', kind: 'landmark', coord: [-122.4783, 37.8199] }] }),
  washington: place({ id: 'washington', name: 'Washington DC', country: 'US', theatre: 'United States', center: [-77.0369, 38.9072], zoom: 10.5,
    sites: [{ id: 'whitehouse', name: 'The White House', kind: 'gov', coord: [-77.0365, 38.8977] }, { id: 'pentagon', name: 'The Pentagon', kind: 'defence', coord: [-77.0563, 38.8719] }, { id: 'dca', name: 'Reagan National (DCA)', kind: 'airfield', coord: [-77.0377, 38.8512] }] }),
  london: place({ id: 'london', name: 'London', country: 'GB', theatre: 'Europe', center: [-0.1276, 51.5074], zoom: 9.5,
    sites: [{ id: 'lhr', name: 'Heathrow (LHR)', kind: 'airfield', coord: [-0.4543, 51.4700] }, { id: 'city', name: 'City of London', kind: 'gov', coord: [-0.0917, 51.5155] }] }),
  telaviv: place({ id: 'telaviv', name: 'Tel Aviv', country: 'IL', theatre: 'Middle East', center: [34.7818, 32.0853], zoom: 10.5,
    sites: [{ id: 'tlv', name: 'Ben Gurion (TLV)', kind: 'airfield', coord: [34.8854, 32.0114] }] }),

  // ---- market regions ----
  //
  // Added 2026-08-15 for the markets Philotas is being sold into: New Zealand,
  // Asia, Europe, and more of the United States.
  //
  // These carry the factory's global layers only — aviation, satellites,
  // seismic, hotspots, news. They do NOT carry transport, vessels, cameras,
  // berths or facilities, because each of those is a national integration with
  // its own registration and terms, and Sydney is the worked example of what
  // one looks like when it is done. A region here therefore renders six layers
  // against Sydney's twelve, and the interface should not imply otherwise.
  //
  // An earlier version of this comment quoted "roughly 100-400 contacts against
  // Sydney's 2,100". Neither number was ever measured for this population, and
  // both were removed on 2026-08-17 rather than dressed up: the only per-region
  // figures this repo can source are aviation counts from the probe artefact
  // (0-563 within 150 nm on run 2, median 39), and an all-layer total has never
  // been recorded for any region.
  //
  // Port cities are chosen deliberately: Rotterdam, Hamburg, Singapore and Los
  // Angeles are among the busiest container ports in the world, so each is a
  // candidate for the port-movements integration that gives Sydney its
  // maritime picture.
  auckland: place({ id: 'auckland', name: 'Auckland', country: 'NZ', theatre: 'Australia & NZ', center: [174.7633, -36.8485], zoom: 10,
    sites: [{ id: 'akl', name: 'Auckland Airport (AKL)', kind: 'airfield', coord: [174.7850, -37.0082] }, { id: 'ports', name: 'Ports of Auckland', kind: 'port', coord: [174.7850, -36.8420] }] }),
  wellington: place({ id: 'wellington', name: 'Wellington', country: 'NZ', theatre: 'Australia & NZ', center: [174.7762, -41.2865], zoom: 10.5,
    sites: [{ id: 'wlg', name: 'Wellington Airport (WLG)', kind: 'airfield', coord: [174.8050, -41.3272] }, { id: 'beehive', name: 'New Zealand Parliament', kind: 'gov', coord: [174.7762, -41.2784] }] }),
  singapore: place({ id: 'singapore', name: 'Singapore', country: 'SG', theatre: 'South East Asia', center: [103.8198, 1.3521], zoom: 10.5,
    sites: [{ id: 'sin', name: 'Changi Airport (SIN)', kind: 'airfield', coord: [103.9915, 1.3644] }, { id: 'psa', name: 'Port of Singapore', kind: 'port', coord: [103.7500, 1.2650] }] }),
  rotterdam: place({ id: 'rotterdam', name: 'Rotterdam', country: 'NL', theatre: 'Europe', center: [4.4777, 51.9244], zoom: 10,
    sites: [{ id: 'maasvlakte', name: 'Maasvlakte II', kind: 'port', coord: [4.0400, 51.9500] }, { id: 'europoort', name: 'Europoort', kind: 'port', coord: [4.1500, 51.9400] }] }),
  hamburg: place({ id: 'hamburg', name: 'Hamburg', country: 'DE', theatre: 'Europe', center: [9.9937, 53.5511], zoom: 10,
    sites: [{ id: 'hafen', name: 'Port of Hamburg', kind: 'port', coord: [9.9330, 53.5350] }, { id: 'ham', name: 'Hamburg Airport (HAM)', kind: 'airfield', coord: [9.9882, 53.6304] }] }),
  amsterdam: place({ id: 'amsterdam', name: 'Amsterdam', country: 'NL', theatre: 'Europe', center: [4.9041, 52.3676], zoom: 10,
    sites: [{ id: 'ams', name: 'Schiphol (AMS)', kind: 'airfield', coord: [4.7639, 52.3105] }, { id: 'haven', name: 'Port of Amsterdam', kind: 'port', coord: [4.8300, 52.4030] }] }),
  newyork: place({ id: 'newyork', name: 'New York', country: 'US', theatre: 'United States', center: [-74.0060, 40.7128], zoom: 10,
    sites: [{ id: 'jfk', name: 'JFK International', kind: 'airfield', coord: [-73.7781, 40.6413] }, { id: 'newark', name: 'Port Newark-Elizabeth', kind: 'port', coord: [-74.1500, 40.6800] }] }),
  losangeles: place({ id: 'losangeles', name: 'Los Angeles', country: 'US', theatre: 'United States', center: [-118.2437, 34.0522], zoom: 9.5,
    sites: [{ id: 'lax', name: 'Los Angeles Intl (LAX)', kind: 'airfield', coord: [-118.4085, 33.9416] }, { id: 'polb', name: 'Port of Long Beach', kind: 'port', coord: [-118.2160, 33.7550] }] }),

  // ---- country views ----
  australia: place({ id: 'australia', name: 'Australia', type: 'country', country: 'AU', theatre: 'Australia & NZ', center: [134, -25], half: [22, 18], zoom: 3.5 }),
  unitedstates: place({ id: 'unitedstates', name: 'United States', type: 'country', country: 'US', theatre: 'United States', center: [-98, 39], half: [30, 16], zoom: 3 }),

  // ---- multi-country region ----
  // The seven theatres have no Pacific entry, so this sits under Australia & NZ
  // — the theatre whose operator is most likely to be looking for it. Flagged
  // rather than resolved: if a Pacific theatre is ever added, this moves.
  southpacific: place({ id: 'southpacific', name: 'South Pacific', type: 'region', theatre: 'Australia & NZ', center: [165, -18], half: [25, 22], zoom: 3.2 }),

  // ---- probed coverage expansion, 2026-08-16 ----
  //
  // 64 regions across the United States, the Middle East, Europe and North East
  // Asia, built from lib/data/region-probe.js. North East Asia had none before
  // this and holds seven of the world's ten busiest container ports.
  //
  // 83 regions after the spread — Europe 24, United States 20, Middle East 15,
  // North East Asia 15, Australia & NZ 7, South East Asia 1, Global 1. Measured
  // 2026-08-17 by counting REGION_LIST by theatre; the command and its output
  // are in the commit message that added this block.
  //
  // Why 64 cold regions cost nothing: see the header of lib/region-catalogue.js,
  // which is where that argument lives and where it stays in step with
  // lib/cache.js.
  //
  // Spread last, so a candidate id colliding with a hand-written region would
  // overwrite it. test/region-probe-artefact.test.js refuses that collision
  // outright, which is the guard; this ordering makes the consequence of losing
  // that guard loud rather than subtle. test/region-schema.test.js counts the
  // keys, which is what catches two candidates collapsing onto one.
  ...buildCatalogueRegions(),
};

// Sydney, not world. A visitor arriving from the trial button lands on the
// flagship build already moving, rather than on a globe they have to navigate.
export const DEFAULT_REGION = 'sydney';

export function getRegion(id) {
  return REGIONS[id] || REGIONS[DEFAULT_REGION];
}

export const REGION_LIST = Object.values(REGIONS).map((r) => ({
  id: r.id, name: r.name, type: r.type || 'city',
  country: r.country || null, theatre: r.theatre,
}));
