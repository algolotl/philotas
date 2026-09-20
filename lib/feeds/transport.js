// Transport — GTFS-Realtime vehicle positions, region-aware.
//
// Sydney runs the Transport for NSW realtime feeds: ferries, trains, buses,
// light rail and metro. Those are keyed — register a free application at
// opendata.transport.nsw.gov.au and set TFNSW_API_KEY.
//
// Canberra light rail stays as a keyless source so the ACT view keeps working
// without any registration.
//
// Which sources a region uses is declared in `region.params.transport.sources`,
// so adding a city's transport is config rather than code. Each source is a
// GTFS-RT FeedMessage protobuf; we decode and emit one Point per vehicle.
//
// Ferries matter disproportionately here: they are the layer that ties the
// maritime picture to the land network at Circular Quay.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { tfnswRequest } from '../tfnsw-limit.js';

const { transit_realtime: rt } = GtfsRealtimeBindings;

const TFNSW_BASE = 'https://api.transport.nsw.gov.au';

// Transport for NSW realtime vehicle position feeds, by mode.
//
// Ferries and light rail are namespaced BY OPERATOR, which the developer docs
// do not make obvious. The bare paths are the trap:
//   /v1/gtfs/vehiclepos/ferries    -> 404
//   /v1/gtfs/vehiclepos/lightrail  -> 200 with an EMPTY 15-byte feed
// The second is worse than the first, because it looks healthy and silently
// contributes nothing. Both were verified against the live gateway.
const TFNSW_SOURCES = {
  ferries: { id: 'ferries', mode: 'Ferry', url: `${TFNSW_BASE}/v1/gtfs/vehiclepos/ferries/sydneyferries` },
  sydneytrains: { id: 'sydneytrains', mode: 'Train', url: `${TFNSW_BASE}/v2/gtfs/vehiclepos/sydneytrains` },
  buses: { id: 'buses', mode: 'Bus', url: `${TFNSW_BASE}/v1/gtfs/vehiclepos/buses` },
  lightrail: { id: 'lightrail', mode: 'Light rail', url: `${TFNSW_BASE}/v1/gtfs/vehiclepos/lightrail/cbdandsoutheast` },
  metro: { id: 'metro', mode: 'Metro', url: `${TFNSW_BASE}/v1/gtfs/vehiclepos/metro` },
};

// Keyless sources, usable with no registration at all.
const KEYLESS_SOURCES = {
  actlightrail: {
    id: 'actlightrail',
    mode: 'Light rail',
    url: process.env.ACT_LIGHTRAIL_URL || 'https://files.transport.act.gov.au/feeds/lightrail.pb',
    auth: null,
  },
};

// One decoded ferry feed, shared by the two callers that need it.
//
// The ferry endpoint has two consumers: fetchTransport, which draws ferries as
// transport vehicles at the transport TTL, and fetchFerriesAsVessels, which
// draws the same hulls as vessels at the vessels TTL. They were each calling
// upstream independently, against a key whose whole-account quota is 60,000
// requests a day. Derived from the TTLs in lib/config.js:
//
//     transport, 5 modes at 10s        43,200/day
//     vessels -> ferries at 5s         17,280/day
//     philotas-ingest ferries at 20s    4,320/day
//     cameras at 300s                      288/day
//     -------------------------------------------
//     total                            65,088/day   against 60,000
//
// On 2026-08-15 that stopped being arithmetic and started being 429s on
// ferries, sydneytrains, buses and the camera feed at once. Serving the second
// consumer from a cached decode removes 17,280 calls and brings the total to
// 47,808, about 80% of quota.
//
// The TTL here is the transport TTL rather than the vessels TTL on purpose: a
// ferry position at most ten seconds old is the same picture, and the vessels
// layer polls faster than the ferries actually report.
const FERRY_FEED_TTL_MS = 10_000;
let ferryFeedCache = null; // { at, feed }

async function fetchFerryFeed(apiKey) {
  if (ferryFeedCache && Date.now() - ferryFeedCache.at < FERRY_FEED_TTL_MS) {
    return ferryFeedCache.feed;
  }
  const res = await tfnswRequest(() =>
    fetch(TFNSW_SOURCES.ferries.url, {
      headers: { Authorization: `apikey ${apiKey}`, 'User-Agent': 'philotas-demo/0.1' },
    })
  );
  if (!res.ok) throw new Error(`ferries ${res.status}`);
  const feed = rt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
  ferryFeedCache = { at: Date.now(), feed };
  return feed;
}

// Exported for the test that pins the deduplication.
export function _resetFerryFeedCache() { ferryFeedCache = null; }

function resolveSources(region) {
  const requested = region?.params?.transport?.sources || ['actlightrail'];
  const key = process.env.TFNSW_API_KEY;
  const sources = [];

  for (const name of requested) {
    if (KEYLESS_SOURCES[name]) {
      sources.push(KEYLESS_SOURCES[name]);
      continue;
    }
    const tfnsw = TFNSW_SOURCES[name];
    // Skip keyed sources with no key rather than failing the whole feed: a
    // missing key should cost you that mode, not the entire transport layer.
    if (tfnsw && key) {
      sources.push({ ...tfnsw, auth: `Authorization: apikey ${key}` });
    }
  }
  return sources;
}

export async function fetchTransport(region) {
  const sources = resolveSources(region);
  if (sources.length === 0) {
    throw new Error('no transport sources configured (set TFNSW_API_KEY for Sydney modes)');
  }

  const features = [];
  const errors = [];
  let okAny = false;

  for (const source of sources) {
    try {
      let feed;
      if (source.id === 'ferries') {
        // Through the shared cache, so the vessels layer's call and this one
        // are the same upstream request. See fetchFerryFeed.
        feed = await fetchFerryFeed(process.env.TFNSW_API_KEY);
      } else {
        const headers = { 'User-Agent': 'philotas-demo/0.1' };
        if (source.auth) {
          const separator = source.auth.indexOf(':');
          headers[source.auth.slice(0, separator).trim()] = source.auth.slice(separator + 1).trim();
        }
        // Shared TfNSW budget: see lib/tfnsw-limit.js.
        const res = await tfnswRequest(() => fetch(source.url, { headers }));
        if (!res.ok) throw new Error(`${source.id} ${res.status}`);
        feed = rt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
      }

      for (const entity of feed.entity) {
        const vehicle = entity.vehicle;
        const position = vehicle?.position;
        if (!position || position.longitude == null || position.latitude == null) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [position.longitude, position.latitude] },
          properties: {
            layer: 'transport',
            mode: source.mode,
            title: `${source.mode} ${vehicle.vehicle?.label || vehicle.trip?.routeId || ''}`.trim(),
            route: vehicle.trip?.routeId || null,
            trip: vehicle.trip?.tripId || null,
            label: vehicle.vehicle?.label || null,
            bearing: position.bearing ?? 0,
            speed_kmh: position.speed != null ? Math.round(position.speed * 3.6) : null,
            status: vehicle.currentStatus != null ? String(vehicle.currentStatus) : null,
            ts: vehicle.timestamp != null ? Number(vehicle.timestamp) * 1000 : null,
          },
        });
      }
      okAny = true;
    } catch (error) {
      errors.push(String(error.message || error));
    }
  }

  if (!okAny) throw new Error(errors.join('; ') || 'transport unreachable');
  return { type: 'FeatureCollection', features, generated: Date.now(), partial: errors.length > 0 };
}

// Ferries only, shaped as VESSELS rather than as transport vehicles.
//
// A Sydney ferry is a vessel. It has a hull, it berths at a wharf, and it is
// the one class of commercial shipping in this harbour whose live position is
// published openly without an AIS subscription. Presenting the real ones as
// vessels beats presenting fabricated ones.
//
// Exported separately rather than read through lib/cache.js because cache.js
// imports this module; going back the other way would be an import cycle.
export async function fetchFerriesAsVessels(region) {
  const key = process.env.TFNSW_API_KEY;
  if (!key) return [];

  // Same shared decode the transport layer uses. This function used to issue
  // its own request at the vessels TTL, which was 17,280 calls a day for a
  // payload the transport poll had already fetched.
  const feed = await fetchFerryFeed(key);

  const vessels = [];
  for (const entity of feed.entity) {
    const vehicle = entity.vehicle;
    const position = vehicle?.position;
    if (!position || position.longitude == null || position.latitude == null) continue;

    const name = (vehicle.vehicle?.label || '').trim();
    vessels.push({
      // No MMSI is published, so the identifier is the operator's vehicle id.
      // Prefixed to make its provenance unmistakable and to guarantee it can
      // never collide with a real 9-digit MMSI.
      mmsi: `TFNSW-${vehicle.vehicle?.id || name || entity.id}`,
      name: name || 'Sydney Ferry',
      ship_type: 'passenger',
      destination: vehicle.trip?.routeId ? `Route ${vehicle.trip.routeId}` : null,
      position: [position.longitude, position.latitude],
      // GTFS speed is metres per second; the maritime layer works in knots.
      speed_over_ground_knots: position.speed != null ? Number((position.speed * 1.94384).toFixed(1)) : null,
      course_over_ground_degrees: position.bearing ?? null,
      last_report_ms: vehicle.timestamp != null ? Number(vehicle.timestamp) * 1000 : Date.now(),
      feed_source: 'tfnsw',
    });
  }
  return vessels;
}
