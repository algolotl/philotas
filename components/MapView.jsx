'use client';

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { trailKey } from '@/lib/trail-key';
import { LAYERS, RENDERERS } from '@/lib/layers';
import { resolveMapStyle } from '@/lib/map-style';

// Keyless basemap: MapLibre GL with a free CARTO style by default, or a
// self-hosted style/tile server (air-gapped) via NEXT_PUBLIC_MAP_STYLE_URL.
// No Google Maps, no API key.
const MAP_STYLE = resolveMapStyle(process.env.NEXT_PUBLIC_MAP_STYLE_URL);
const REFRESH_MS = 12_000;

// MapView owns the imperative MapLibre instance. React drives it through props:
//   - `enabled`  : which layer ids are visible
//   - `command`  : a {seq, center, zoom, pitch} camera move (new object each time)
// and reports upward via onStatus (feed health) and onSelect (clicked contact).
export default function MapView({ enabled, command, onSelect, onStatus, ontology, showLinks, region, activeLayers, sites, replay, replayFrames, annotations, annotateMode, onAddAnnotation, onCamera, alerts, detections }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const readyRef = useRef(false);
  const enabledRef = useRef(enabled);
  const onSelectRef = useRef(onSelect);
  const onStatusRef = useRef(onStatus);
  const trailsRef = useRef({}); // layerId -> Map(contactId -> { coords, missed })
  const regionRef = useRef(region);
  const activeRef = useRef(activeLayers);
  const sitesRef = useRef(sites);
  const markersRef = useRef([]); // live maplibre Marker instances
  const replayRef = useRef(replay);
  const annotateModeRef = useRef(annotateMode);
  const onAddRef = useRef(onAddAnnotation);
  const onCameraRef = useRef(onCamera);

  useEffect(() => {
    onSelectRef.current = onSelect; onStatusRef.current = onStatus;
    regionRef.current = region; activeRef.current = activeLayers; sitesRef.current = sites;
    replayRef.current = replay;
    annotateModeRef.current = annotateMode; onAddRef.current = onAddAnnotation; onCameraRef.current = onCamera;
  });

  // ---- init (once) ----
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE,
      center: [149.1244, -35.3081],
      zoom: 9,
      attributionControl: { compact: true },
      // 3D globe (MapLibre v5). It curves the earth at low zoom and eases into a
      // flat map as you zoom into a city — best of both for a world-then-city COP.
      projection: { type: 'globe' },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

    // MapLibre reports style, tile and WebGL failures through this event. With
    // no handler they vanish silently, which is how a blank map with a healthy
    // canvas becomes very hard to diagnose.
    map.on('error', (e) => {
      console.error('[maplibre]', e?.error?.message || e?.error || e);
    });
    if (typeof window !== 'undefined') window.__parallaxMap = map;

    map.on('styleimagemissing', (e) => {
      if (e.id !== 'triangle' || map.hasImage('triangle')) return;
      const s = 18, c = document.createElement('canvas'); c.width = c.height = s;
      const ctx = c.getContext('2d');
      ctx.beginPath(); ctx.moveTo(s / 2, 1); ctx.lineTo(s - 2, s - 2); ctx.lineTo(s / 2, s * 0.7); ctx.lineTo(2, s - 2);
      ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill();
      map.addImage('triangle', { width: s, height: s, data: ctx.getImageData(0, 0, s, s).data }, { sdf: true });
    });

    let timer;
    map.on('load', async () => {
      try { map.setProjection({ type: 'globe' }); } catch { /* v4 fallback: flat */ }
      addTrailLayers(map);                                  // under the points
      addOntologyLayer(map);                                // resolved cross-feed links
      for (const layer of LAYERS) registerLayer(map, layer, onSelectRef);
      addAnnotationLayer(map, onSelectRef, annotateModeRef); // human augmentations (top)
      addAlertLayer(map);                                   // rule-triggered alert rings
      addDetectionLayer(map);                               // object-detection rings
      readyRef.current = true;
      drawSites(map, markersRef, sitesRef.current);

      // Annotate mode: a map click drops a human annotation.
      map.on('click', (e) => {
        if (annotateModeRef.current) onAddRef.current?.([e.lngLat.lng, e.lngLat.lat]);
      });
      // Report camera moves so a workspace can save/restore the view.
      map.on('moveend', () => {
        const c = map.getCenter();
        onCameraRef.current?.({ center: [c.lng, c.lat], zoom: map.getZoom() });
      });
      applyVisibility(map, enabledRef.current);

      // If the container measured 0px at construction (common with dynamically
      // mounted maps), force a re-measure so the canvas fills the viewport.
      map.resize();
      setTimeout(() => map.resize(), 250);

      refreshAll(map, onStatusRef, trailsRef.current, regionRef, activeRef, replayRef);
      timer = setInterval(() => refreshAll(map, onStatusRef, trailsRef.current, regionRef, activeRef, replayRef), REFRESH_MS);
    });

    const onWinResize = () => map.resize();
    window.addEventListener('resize', onWinResize);

    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', onWinResize);
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
  }, []);

  // ---- visibility follows `enabled` ----
  useEffect(() => {
    enabledRef.current = enabled;
    if (readyRef.current && mapRef.current) applyVisibility(mapRef.current, enabled);
  }, [enabled]);

  // ---- camera follows `command` ----
  useEffect(() => {
    if (command && command.center && mapRef.current) {
      mapRef.current.flyTo({ center: command.center, zoom: command.zoom ?? 11, pitch: command.pitch ?? 0 });
    }
  }, [command]);

  // ---- resolved ontology links follow `ontology` / `showLinks` ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource || !map.getSource('ontology-links')) return;
    const features = (ontology?.links || [])
      .filter((l) => l.fromCoord && l.toCoord)
      .map((l) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [l.fromCoord, l.toCoord] },
        properties: { confidence: l.confidence, type: l.type },
      }));
    map.getSource('ontology-links').setData({ type: 'FeatureCollection', features });
    if (map.getLayer('ontology-links')) map.setLayoutProperty('ontology-links', 'visibility', showLinks ? 'visible' : 'none');
  }, [ontology, showLinks]);

  // ---- region switch: wipe every source + trail so old data doesn't linger ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    trailsRef.current = {};
    for (const layer of LAYERS) {
      map.getSource(`src-${layer.id}`)?.setData(emptyFC());
      map.getSource(`trail-${layer.id}`)?.setData(emptyFC());
    }
    map.getSource('ontology-links')?.setData(emptyFC());
  }, [region]);

  // ---- fetch the active layers whenever the region's layer set changes ----
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) refreshAll(map, onStatusRef, trailsRef.current, regionRef, activeRef);
  }, [activeLayers, region]);

  // ---- fixed-site markers follow the region ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    drawSites(map, markersRef, sites || []);
  }, [sites]);

  // ---- human annotations follow the `annotations` prop ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getSource('annotations')) return;
    map.getSource('annotations').setData({
      type: 'FeatureCollection',
      features: (annotations || []).map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
        properties: { layer: 'annotation', title: a.label, label: a.label, note: a.note || '' },
      })),
    });
  }, [annotations]);

  // ---- crosshair cursor while annotating ----
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) map.getCanvas().style.cursor = annotateMode ? 'crosshair' : '';
  }, [annotateMode]);

  // ---- alert rings follow `alerts` ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getSource('alerts')) return;
    map.getSource('alerts').setData({
      type: 'FeatureCollection',
      features: (alerts || []).filter((a) => a.coord).map((a) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: a.coord }, properties: { label: a.label },
      })),
    });
  }, [alerts]);

  // ---- object-detection rings follow `detections` ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getSource('detections')) return;
    map.getSource('detections').setData({
      type: 'FeatureCollection',
      features: (detections || []).filter((d) => d.coord).map((d) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: d.coord },
        properties: {
          id: d.id, label: d.class || 'detection', class: d.class, score: d.score,
          source: d.source || 'vision', sourceId: d.sourceId || '', detectedAt: d.detected_at_ms || Date.now(),
        },
      })),
    });
  }, [detections]);

  // ---- replay: show historical frames; restore live when it ends ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    if (replay) {
      for (const layer of LAYERS) {
        map.getSource(`src-${layer.id}`)?.setData(replayFrames?.[layer.id] || emptyFC());
        map.getSource(`trail-${layer.id}`)?.setData(emptyFC()); // trails are a live-only concept
      }
    } else {
      trailsRef.current = {};
      refreshAll(map, onStatusRef, trailsRef.current, regionRef, activeRef, replayRef);
    }
  }, [replay, replayFrames]);

  return <div className="map-root" ref={containerRef} />;
}

// Human annotations: a distinct yellow marker + label, clickable for the note.
function addAnnotationLayer(map, onSelectRef, annotateModeRef) {
  map.addSource('annotations', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'annotations', type: 'circle', source: 'annotations',
    paint: { 'circle-radius': 6, 'circle-color': '#facc15', 'circle-stroke-color': '#1a1205', 'circle-stroke-width': 2 },
  });
  map.addLayer({
    id: 'annotations-label', type: 'symbol', source: 'annotations',
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Open Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#facc15', 'text-halo-color': '#000', 'text-halo-width': 1 },
  });
  map.on('click', 'annotations', (e) => {
    const p = e.features[0].properties;
    onSelectRef.current?.({
      layer: { color: '#facc15', label: 'Annotation' },
      properties: { title: p.label },
      rows: [['type', 'human annotation'], ['note', p.note || '—']],
    });
  });
  map.on('mouseenter', 'annotations', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'annotations', () => (map.getCanvas().style.cursor = annotateModeRef.current ? 'crosshair' : ''));
}

// Rule-triggered alerts: a bright red ring around the offending entity.
function addAlertLayer(map) {
  map.addSource('alerts', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'alerts', type: 'circle', source: 'alerts',
    paint: {
      'circle-radius': 14, 'circle-color': 'rgba(239,68,68,0.12)',
      'circle-stroke-color': '#ef4444', 'circle-stroke-width': 2.5,
    },
  });
}

// Object detections: an orange ring, distinct from alerts (red) and annotations
// (yellow). Clickable for the detection detail.
function addDetectionLayer(map) {
  map.addSource('detections', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'detections', type: 'circle', source: 'detections',
    paint: {
      'circle-radius': 10, 'circle-color': 'rgba(251,146,60,0.2)',
      'circle-stroke-color': '#fb923c', 'circle-stroke-width': 2,
    },
  });
  map.on('click', 'detections', (e) => {
    const p = e.features[0].properties;
    new maplibregl.Popup({ offset: 12 })
      .setLngLat(e.features[0].geometry.coordinates)
      .setHTML('<h4 style="color:#fb923c">Detection: ' + (p.class || 'object') + '</h4>' +
        '<div class="pop-row"><span class="k">confidence</span><span>' + Math.round((p.score || 0) * 100) + '%</span></div>' +
        '<div class="pop-row"><span class="k">source</span><span>' + (p.source || 'vision') + '</span></div>')
      .addTo(map);
  });
  map.on('mouseenter', 'detections', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'detections', () => (map.getCanvas().style.cursor = ''));
}

// Dashed lines between resolved entities, coloured by confidence.
function addOntologyLayer(map) {
  map.addSource('ontology-links', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'ontology-links', type: 'line', source: 'ontology-links',
    layout: { 'line-cap': 'round' },
    paint: {
      // Deliberately quiet. These are context, not contacts: an operator should
      // read them when they look for them, not have them compete with the
      // vessels and vehicles the picture is actually about. Muted to the
      // Bluebird palette, thinner, and with a longer dash so a dense link set
      // reads as texture rather than as a bright cage over the map.
      'line-color': ['interpolate', ['linear'], ['get', 'confidence'],
        0.3, '#7E93AD',   // low confidence: near-neutral grey
        0.7, '#5D4FFF',   // royal
        1, '#7EF9FF'],    // cyan, reserved for structural certainty
      'line-width': ['interpolate', ['linear'], ['get', 'confidence'], 0.3, 0.5, 1, 1.3],
      'line-opacity': ['interpolate', ['linear'], ['get', 'confidence'], 0.3, 0.22, 1, 0.45],
      'line-dasharray': [3, 4],
    },
  });
}

// ---------------------------------------------------------------- helpers
function registerLayer(map, layer, onSelectRef) {
  const src = `src-${layer.id}`;
  map.addSource(src, { type: 'geojson', data: emptyFC() });

  if (layer.type === 'aircraft') {
    map.addLayer({
      id: layer.id, type: 'symbol', source: src,
      layout: {
        'icon-image': 'triangle', 'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-size': 0.8,
        'text-field': ['get', 'callsign'], 'text-font': ['Open Sans Regular'],
        'text-size': 10, 'text-offset': [0, 1.3], 'text-optional': true,
      },
      paint: { 'icon-color': layer.color, 'text-color': layer.color, 'text-halo-color': '#000', 'text-halo-width': 1 },
    });
  } else if (layer.type === 'vessel') {
    // Vessels carry more meaning than a dot can hold: what kind of ship, how
    // big a deal it is, and — most importantly — whether it is still
    // transmitting. A vessel that has stopped reporting gets a hollow red ring
    // so a gap reads at a glance rather than needing a click.
    map.addLayer({
      id: layer.id, type: 'circle', source: src,
      paint: {
        'circle-radius': ['match', ['get', 'ship_type'],
          'cruise', 8, 'cargo', 7, 'tanker', 7, 'naval', 7,
          'passenger', 5, 'tug', 4, 'pilot', 4, 'pleasure', 3,
          5],
        'circle-color': ['match', ['get', 'ship_type'],
          'passenger', '#7EF9FF', 'cruise', '#A78BFA', 'cargo', '#3FA2E8',
          'tanker', '#F59E0B', 'tug', '#8B81FF', 'naval', '#EF4444',
          'pilot', '#4FC1F0', 'pleasure', '#9FB2CC',
          '#7E93AD'],
        // Three states, each visually distinct:
        //   not reporting     -> red ring, hollow (a transmission gap)
        //   expected arrival  -> hollow ring (scheduled, NOT yet alongside)
        //   present           -> filled
        // A scheduled arrival drawn solid would assert a hull is at a berth it
        // reaches in up to two days. Hollow is the map's way of saying "due",
        // and it is what made widening the horizon to 48h defensible.
        'circle-stroke-color': [
          'case',
          ['==', ['get', 'reporting'], false], '#EF4444',
          ['==', ['get', 'expected'], true], '#7EF9FF',
          '#0B1B33',
        ],
        'circle-stroke-width': [
          'case',
          ['==', ['get', 'reporting'], false], 3,
          ['==', ['get', 'expected'], true], 2,
          1.5,
        ],
        'circle-opacity': [
          'case',
          ['==', ['get', 'reporting'], false], 0.25,
          ['==', ['get', 'expected'], true], 0.12,
          0.9,
        ],
      },
    });
  } else if (layer.type === 'quake') {
    map.addLayer({
      id: layer.id, type: 'circle', source: src,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['coalesce', ['get', 'magnitude'], 1], 0, 3, 6, 22],
        'circle-color': layer.color, 'circle-opacity': 0.35,
        'circle-stroke-color': layer.color, 'circle-stroke-width': 1.5,
      },
    });
  } else {
    // 'circle' and 'vehicle' both render as dots.
    map.addLayer({
      id: layer.id, type: 'circle', source: src,
      paint: {
        'circle-radius': layer.radius || 5, 'circle-color': layer.color, 'circle-opacity': 0.85,
        'circle-stroke-color': '#0a0e14', 'circle-stroke-width': 1.5,
      },
    });
  }

  map.on('click', layer.id, (e) => {
    const f = e.features[0];
    const rows = (RENDERERS[layer.id]?.(f.properties) || []).filter(([, v]) => v != null && v !== '');
    onSelectRef.current?.({ layer, properties: f.properties, rows, coord: f.geometry?.coordinates });
    new maplibregl.Popup({ offset: 12 })
      .setLngLat(f.geometry.coordinates)
      .setHTML(`<h4 style="color:${layer.color}">${f.properties.title || ''}</h4>` +
        rows.slice(0, 5).map(([k, v]) => `<div class="pop-row"><span class="k">${k}</span><span>${v}</span></div>`).join(''))
      .addTo(map);
  });
  map.on('mouseenter', layer.id, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', layer.id, () => (map.getCanvas().style.cursor = ''));
}

function drawSites(map, markersRef, sites) {
  for (const m of markersRef.current) m.remove();
  markersRef.current = sites.map((site) =>
    new maplibregl.Marker({ color: '#5b6b82', scale: 0.6 })
      .setLngLat(site.coord)
      .setPopup(new maplibregl.Popup({ offset: 14 }).setHTML(`<h4>${site.name}</h4><div class="muted">${site.kind}</div>`))
      .addTo(map)
  );
}

async function refreshAll(map, onStatusRef, trails, regionRef, activeRef, replayRef) {
  if (replayRef?.current) return; // frozen on a historical frame
  const region = regionRef.current;
  const active = new Set(activeRef.current || []);
  const status = {};
  await Promise.all(LAYERS.map(async (layer) => {
    if (!active.has(layer.id)) {
      // Not part of this region — make sure any prior data is cleared.
      map.getSource(`src-${layer.id}`)?.setData(emptyFC());
      return;
    }
    try {
      const fc = await (await fetch(`/api/feeds/${layer.id}?region=${region}`)).json();
      const source = map.getSource(`src-${layer.id}`);
      if (source) source.setData(fc.type ? fc : emptyFC());
      if (layer.trail) updateTrail(map, layer, fc, trails);
      // `source` and `notice` ride along from the feed payload so a degraded
      // layer can declare itself — camera sites with no imagery, hotspots with
      // no FIRMS key, an empty vessel picture. A picture that cannot tell you
      // it is not live is worse than no picture.
      status[layer.id] = {
        count: fc.count ?? 0,
        error: fc.error || null,
        stale: !!fc.stale,
        source: fc.source || null,
        notice: fc.notice || null,
        from_archive_ms: fc.from_archive_ms || null,
        live: fc.live !== false,
      };
    } catch (err) {
      status[layer.id] = { count: 0, error: String(err), stale: true, source: null, notice: null };
    }
  }));
  onStatusRef.current?.(status);
}

// ---- trails: keep a short rolling history of each moving contact ----
function addTrailLayers(map) {
  for (const layer of LAYERS) {
    if (!layer.trail) continue;
    map.addSource(`trail-${layer.id}`, { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: `trail-${layer.id}`, type: 'line', source: `trail-${layer.id}`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': layer.color, 'line-width': 1.5, 'line-opacity': 0.4 },
    });
  }
}

// trailKey lives in lib/trail-key.js so it can be tested. This component
// touches `window` at import, so nothing in it is reachable under bare
// `node --test` — which is how a key that collided across vehicles shipped
// with a green suite. See that file for the measurement.

function updateTrail(map, layer, fc, trails) {
  const store = trails[layer.id] || (trails[layer.id] = new Map());
  const seen = new Set();
  for (const f of fc.features || []) {
    const key = trailKey(layer.id, f.properties);
    const c = f.geometry?.coordinates;
    if (!key || !c) continue;
    seen.add(key);
    const rec = store.get(key) || { coords: [], missed: 0 };
    const last = rec.coords[rec.coords.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) rec.coords.push(c);
    if (rec.coords.length > 25) rec.coords.shift();
    rec.missed = 0;
    store.set(key, rec);
  }
  // Drop contacts we haven't seen for a while so memory stays bounded.
  for (const [key, rec] of store) if (!seen.has(key) && ++rec.missed > 8) store.delete(key);

  const features = [...store.values()].filter((r) => r.coords.length > 1)
    .map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: {} }));
  map.getSource(`trail-${layer.id}`)?.setData({ type: 'FeatureCollection', features });
}

function applyVisibility(map, enabled) {
  const set = new Set(enabled);
  for (const layer of LAYERS) {
    const vis = set.has(layer.id) ? 'visible' : 'none';
    if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', vis);
    if (layer.trail && map.getLayer(`trail-${layer.id}`)) map.setLayoutProperty(`trail-${layer.id}`, 'visibility', vis);
  }
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
