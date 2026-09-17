// Ferry position source for the ingest service.
//
// Replaces the aisstream websocket client, which was removed after the provider
// went silent — it accepted subscriptions and delivered nothing, worldwide, with
// no terms of service and an unanswered issue backlog. Depending on it was a
// liability regardless of whether it came back.
//
// Sydney Ferries publish real positions through Transport for NSW under CC BY
// 4.0, and a ferry is a vessel: it has a hull, it holds a course, it berths at a
// wharf. That gives the detectors genuine position series to run on, which is
// all they ever needed — they take a track and a timestamp and care nothing for
// where it came from.
//
// This polls rather than streams, so the original reason for a separate service
// (a websocket must outlive a request) no longer applies. The service is kept
// because it still owns two things worth having outside the request path:
// durable position history, and detector passes over the whole fleet on a timer.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { transit_realtime: rt } = GtfsRealtimeBindings;

const FERRIES_URL = 'https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/ferries/sydneyferries';

// TfNSW Bronze is 60,000 calls/day and 5/sec, shared across every API on the
// key — and the application is already spending most of that on the transport
// and camera layers. 20s here is ~4,300 calls/day, which the fleet-wide budget
// absorbs comfortably.
const POLL_INTERVAL_MS = 20_000;

export function createFerrySource({ apiKey, onReport, log = console }) {
  let stopped = false;
  let timer = null;
  let pollCount = 0;
  let reportCount = 0;
  let lastOk = null;

  async function poll() {
    if (stopped) return;
    try {
      const res = await fetch(FERRIES_URL, {
        headers: { Authorization: `apikey ${apiKey}`, 'User-Agent': 'parallax-ingest/0.1' },
      });
      if (!res.ok) throw new Error(`ferries ${res.status}`);

      const feed = rt.FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
      let n = 0;
      for (const entity of feed.entity) {
        const vehicle = entity.vehicle;
        const position = vehicle?.position;
        if (!position || position.longitude == null || position.latitude == null) continue;

        const name = (vehicle.vehicle?.label || '').trim();
        onReport({
          kind: 'position',
          // Prefixed so it can never be mistaken for, or collide with, a real
          // 9-digit MMSI. These vessels have no AIS identity here.
          mmsi: `TFNSW-${vehicle.vehicle?.id || name || entity.id}`,
          name: name || 'Sydney Ferry',
          ship_type: 'passenger',
          destination: vehicle.trip?.routeId ? `Route ${vehicle.trip.routeId}` : null,
          position: [position.longitude, position.latitude],
          // GTFS reports metres per second; the maritime layer works in knots.
          speed_over_ground_knots:
            position.speed != null ? Number((position.speed * 1.94384).toFixed(1)) : null,
          course_over_ground_degrees: position.bearing ?? null,
          // The vehicle's own timestamp, not arrival time: using arrival time
          // would fold our polling jitter into the cadence baseline the gap
          // detector derives from it.
          timestamp_ms: vehicle.timestamp != null ? Number(vehicle.timestamp) * 1000 : Date.now(),
        });
        n += 1;
      }
      reportCount += n;
      lastOk = Date.now();
      if (pollCount === 0) log.info(`[ferries] connected, ${n} vessels in first poll`);
      pollCount += 1;
    } catch (error) {
      log.error('[ferries] poll failed:', error.message);
    }
  }

  poll();
  timer = setInterval(poll, POLL_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    stats: () => ({
      messages: reportCount,
      polls: pollCount,
      // "Connected" means a poll succeeded recently, not that a socket is open.
      connected: lastOk != null && Date.now() - lastOk < POLL_INTERVAL_MS * 3,
    }),
  };
}
