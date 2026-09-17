// Example API connector — NASA EONET natural-event tracker (keyless, global).
// Wildfires, storms, volcanoes, ice etc. Demonstrates adding a live API source
// in one file: a URL + a normalize() to GeoJSON, and it's a first-class layer.

import { defineConnector, apiPull } from '../define.js';

export const eonetConnector = defineConnector({
  id: 'events',
  label: 'Natural events (EONET)',
  kind: 'api',
  ttl: 300_000,
  layer: { color: '#fb7185', type: 'circle', radius: 5 },
  render: (p) => [['category', p.category], ['date', p.date], ['source', 'NASA EONET']],
  pull: apiPull({
    url: () => 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=300',
    normalize: (data, region) => {
      const b = region?.bbox;
      const out = [];
      for (const ev of data.events || []) {
        const g = (ev.geometry || []).filter((x) => x.type === 'Point').pop();
        if (!g) continue;
        const [lon, lat] = g.coordinates;
        if (b && !(lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north)) continue;
        out.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: { layer: 'events', title: ev.title, category: ev.categories?.[0]?.title || 'event', date: g.date },
        });
      }
      return out;
    },
  }),
});
