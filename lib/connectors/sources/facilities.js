// Example DATALAKE connector — facilities from a "lake".
//
// Here the lake is a bundled sample table; in production swap `query` for a real
// client, e.g.:
//   query: async (region) => {
//     const { rows } = await databricks.query(
//       `SELECT name, type, operator, lon, lat FROM ops.facilities
//        WHERE lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?`,
//       [region.bbox.west, region.bbox.east, region.bbox.south, region.bbox.north]);
//     return rows;
//   }
// Everything downstream (caching, snapshots, layer, ontology) is unchanged.

import sample from '../../data/sample-lake/facilities.json';
import { defineConnector, datalakePull } from '../define.js';

export const facilitiesConnector = defineConnector({
  id: 'facilities',
  label: 'Facilities (datalake)',
  kind: 'datalake',
  ttl: 600_000,
  layer: { color: '#a3e635', type: 'circle', radius: 5 },
  render: (p) => [['type', p.ftype], ['operator', p.operator], ['source', 'datalake']],
  pull: datalakePull({
    query: async () => sample, // <- swap for a Databricks/Snowflake/DuckDB query
    toFeature: (row) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: { layer: 'facilities', title: row.name, ftype: row.type, operator: row.operator },
    }),
  }),
});
