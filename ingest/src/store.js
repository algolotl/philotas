// Postgres writes for the ingest service.
//
// The app only ever reads these tables (see lib/db.js). Writing is entirely
// this service's job, which is what lets the map keep working on last-known
// state when ingest dies.
//
// Vessel state is flushed in batches rather than written per message. A busy
// harbour delivers several hundred position reports a minute, and a round trip
// per report would spend the whole budget on transaction overhead.

import pg from 'pg';

export function createStore({ connectionString, log = console }) {
  const pool = new pg.Pool({ connectionString, max: 4 });

  return {
    // Upsert current vessel state. One statement, many rows.
    async flushVessels(vessels) {
      if (vessels.length === 0) return 0;
      const values = [];
      const params = [];
      vessels.forEach((v, i) => {
        const b = i * 9;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
        params.push(
          v.mmsi, v.name, v.ship_type, v.destination,
          v.position[0], v.position[1],
          v.speed_over_ground_knots, v.course_over_ground_degrees,
          v.last_report_ms
        );
      });
      await pool.query(
        `INSERT INTO vessels (mmsi,name,ship_type,destination,lon,lat,
            speed_over_ground_knots,course_over_ground_degrees,last_report_ms)
         VALUES ${values.join(',')}
         ON CONFLICT (mmsi) DO UPDATE SET
           -- COALESCE so a position report, which carries no name or
           -- destination, cannot erase what a static report established.
           name = COALESCE(EXCLUDED.name, vessels.name),
           ship_type = COALESCE(EXCLUDED.ship_type, vessels.ship_type),
           destination = COALESCE(EXCLUDED.destination, vessels.destination),
           lon = EXCLUDED.lon,
           lat = EXCLUDED.lat,
           speed_over_ground_knots = EXCLUDED.speed_over_ground_knots,
           course_over_ground_degrees = EXCLUDED.course_over_ground_degrees,
           last_report_ms = EXCLUDED.last_report_ms`,
        params
      );
      return vessels.length;
    },

    // Append position history, used by replay and by the detectors on restart.
    async appendPositions(rows) {
      if (rows.length === 0) return 0;
      const values = [];
      const params = [];
      rows.forEach((r, i) => {
        const b = i * 6;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(r.mmsi, r.timestamp_ms, r.position[0], r.position[1],
          r.speed_over_ground_knots, r.course_over_ground_degrees);
      });
      await pool.query(
        `INSERT INTO vessel_positions (mmsi,timestamp_ms,lon,lat,
            speed_over_ground_knots,course_over_ground_degrees)
         VALUES ${values.join(',')}`,
        params
      );
      return rows.length;
    },

    // Detector output. The id is deterministic per (type, mmsi, trigger time)
    // so a detector that keeps firing while a condition persists updates one
    // row instead of filling the table with duplicates of the same event.
    async recordEvent(event, region) {
      const id = `${event.type}:${event.mmsi}:${event.started_at_ms || event.last_report_ms || event.detected_at_ms}`;
      const position = event.position || event.last_position || null;
      await pool.query(
        `INSERT INTO events (id,type,mmsi,region,detected_at_ms,lon,lat,evidence,detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           detected_at_ms = EXCLUDED.detected_at_ms,
           evidence = EXCLUDED.evidence,
           detail = EXCLUDED.detail`,
        [id, event.type, event.mmsi, region, event.detected_at_ms,
         position?.[0] ?? null, position?.[1] ?? null,
         event.evidence, JSON.stringify(event)]
      );
      return id;
    },

    // Keep history bounded. Called on a slow timer, not per write.
    async pruneOlderThan(cutoffMs) {
      const r = await pool.query('DELETE FROM vessel_positions WHERE timestamp_ms < $1', [cutoffMs]);
      return r.rowCount;
    },

    async close() {
      await pool.end().catch((e) => log.error('[store] close:', e.message));
    },
  };
}
