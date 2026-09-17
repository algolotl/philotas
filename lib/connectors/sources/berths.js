// DATALAKE connector — Sydney berths, wharves and terminals.
//
// Berths are the fixed infrastructure the maritime picture hangs off. Two
// things need them: the loitering detector, which uses them to tell a vessel
// doing its job at a wharf from one holding station in a channel, and the
// ontology, which resolves a vessel to the berth it is alongside.
//
// The lake here is a bundled sample table. In production swap `query` for a
// real client against the port authority's berth register:
//   query: async (region) => {
//     const { rows } = await databricks.query(
//       `SELECT id, name, berth_type, operator, lon, lat, radius_metres
//        FROM ports.berths WHERE port_code = ?`, ['AUSYD']);
//     return rows;
//   }
// Everything downstream — caching, snapshots, layer, ontology — is unchanged.

import sample from '../../data/sample-lake/berths.json';
import { defineConnector, datalakePull } from '../define.js';

// Berth type drives the colour ramp in the UI legend.
const TYPE_LABELS = {
  ferry: 'Ferry wharf',
  cruise: 'Cruise terminal',
  container: 'Container terminal',
  tanker: 'Tanker berth',
  bulk: 'Bulk berth',
  naval: 'Naval base',
  anchorage: 'Anchorage',
};

export const berthsConnector = defineConnector({
  id: 'berths',
  label: 'Berths & terminals',
  kind: 'datalake',
  // Fixed infrastructure. It does not move, so poll rarely.
  ttl: 3_600_000,
  layer: { color: '#7EF9FF', type: 'circle', radius: 5 },
  render: (p) => [
    ['type', TYPE_LABELS[p.berth_type] || p.berth_type],
    ['operator', p.operator],
    ['max LOA', p.max_loa_metres ? `${p.max_loa_metres} m` : null],
    ['source', 'datalake'],
  ],
  pull: datalakePull({
    query: async () => sample, // <- swap for the port authority berth register
    toFeature: (row) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: {
        layer: 'berths',
        title: row.name,
        berth_id: row.id,
        berth_type: row.berth_type,
        operator: row.operator,
        radius_metres: row.radius_metres,
        max_loa_metres: row.max_loa_metres,
      },
    }),
  }),
});

// The detectors need berths as plain records, not GeoJSON. Exported separately
// so the loitering detector's berth list and the map layer cannot drift apart.
export function berthRecords() {
  return sample.map((row) => ({
    id: row.id,
    name: row.name,
    position: [row.lon, row.lat],
    radius_metres: row.radius_metres,
    berth_type: row.berth_type,
  }));
}
