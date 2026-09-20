// Deep space — NASA Deep Space Network "DSN Now", Canberra complex only.
// CDSCC at Tidbinbilla is one of three DSN ground stations on Earth. We filter
// the global feed to the Canberra dishes (DSS 34/35/36/43) and surface what
// each is actively tracking.

import { XMLParser } from 'fast-xml-parser';
import { SITES } from '../config.js';

const DSN_NOW = 'https://eyes.nasa.gov/dsn/data/dsn.xml';
const CANBERRA_DISHES = new Set(['DSS34', 'DSS35', 'DSS36', 'DSS43']);

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

export async function fetchSpace() {
  const res = await fetch(DSN_NOW, { headers: { 'User-Agent': 'philotas-demo/0.1' } });
  if (!res.ok) throw new Error(`DSN ${res.status}`);
  const doc = parser.parse(await res.text());

  const base = SITES.find((s) => s.id === 'cdscc').coord;
  const dishes = asArray(doc?.dsn?.dish).filter((d) => CANBERRA_DISHES.has(d['@_name']));

  const features = dishes.map((d, idx) => {
    const offset = (idx - (dishes.length - 1) / 2) * 0.012;
    const targets = asArray(d.target).map((t) => t['@_name']).filter(Boolean);
    const down = asArray(d.downSignal).filter((s) => s['@_signalType'] === 'data');
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [base[0] + offset, base[1] - Math.abs(offset) * 0.4] },
      properties: {
        layer: 'space', title: d['@_name'], friendly: d['@_friendlyName'] || d['@_name'],
        azimuth: d['@_azimuthAngle'], elevation: d['@_elevationAngle'],
        tracking: targets.join(', ') || null, active: targets.length > 0,
        downlink_rate: down[0]?.['@_dataRate'] || null,
      },
    };
  });

  return { type: 'FeatureCollection', features, generated: Date.now() };
}
