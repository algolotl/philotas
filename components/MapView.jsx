'use client';

import { useEffect, useRef, useState } from 'react';
import { trailKey } from '@/lib/trail-key';
import { LAYERS, RENDERERS } from '@/lib/layers';

// Google Maps JavaScript API key. Inlined at build time from .env.local -
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY. Without a key the map shows a clear
// instruction card instead of a blank canvas (see renderMapError).
const GMAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
// Optional vector-map id. When set the roadmap is the vector renderer, which
// unlocks colorScheme (proper dark mode) and tilt. Without it the raster
// roadmap is styled dark through the styles array instead. Either way the
// satellite / hybrid / terrain basemaps work.
const GMAPS_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_ID;

const REFRESH_MS = 12_000;

export const BASEMAPS = [
  { id: 'dark', label: 'Dark' },
  { id: 'roadmap', label: 'Map' },
  { id: 'satellite', label: 'Sat' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'terrain', label: 'Terrain' },
];

// Dark palette for the raster roadmap (only used when no mapId is configured).
// Kept deliberately close to the Bluebird #0B1B33 surface the old CARTO
// dark-matter style provided, so the switch to Google does not also change the
// product's colour temperature.
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#101a29' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0a0e14' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ea3bd' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#24364d' }] },
  { featureType: 'administrative.land_parcel', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.business', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1a2436' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#243550' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#7188a5' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#223050' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#2e4a70' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#93aed4' }] },
  { featureType: 'road.arterial', elementType: 'labels.text.fill', stylers: [{ color: '#7e93ad' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d2139' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4e7ba0' }] },
];

// ------------------------------------------------------------------ loader
// One script tag per page load, one promise per component tree. The callback
// name is unique per attempt so a failed load can be retried cleanly.
let gmapsPromise = null;
function loadGoogleMaps() {
  if (gmapsPromise) return gmapsPromise;
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.google && window.google.maps && window.google.maps.Map) {
    gmapsPromise = Promise.resolve(window.google.maps);
    return gmapsPromise;
  }
  if (!GMAPS_KEY) {
    return Promise.reject(new Error('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not set'));
  }
  gmapsPromise = new Promise((resolve, reject) => {
    const cb = '__philotasGmaps_' + Date.now();
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(GMAPS_KEY) + '&v=weekly&loading=async&callback=' + cb;
    s.async = true;
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      delete window[cb];
      gmapsPromise = null;
      reject(new Error('Google Maps script timed out'));
    }, 15_000);
    window[cb] = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cb];
      resolve(window.google.maps);
    };
    s.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cb];
      gmapsPromise = null;
      reject(new Error('Google Maps script failed to load - check the API key and domain restrictions'));
    };
    document.head.appendChild(s);
  });
  return gmapsPromise;
}

// MapView owns the imperative Google Maps instance. React drives it through
// props - enabled (visible layer ids), command (camera moves), basemap - and
// reports upward via onStatus (feed health), onSelect (clicked contact) and
// onCamera (for workspace save/restore).
export default function MapView({
  enabled, command, onSelect, onStatus, ontology, showLinks, region, activeLayers,
  sites, replay, replayFrames, annotations, annotateMode, onAddAnnotation,
  onCamera, alerts, detections, basemap, onBasemapChange,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const googleRef = useRef(null);
  const readyRef = useRef(false);
  const enabledRef = useRef(enabled);
  const onSelectRef = useRef(onSelect);
  const onStatusRef = useRef(onStatus);
  const trailsRef = useRef({}); // layerId -> Map(contactId -> { coords, missed })
  const regionRef = useRef(region);
  const activeRef = useRef(activeLayers);
  const sitesRef = useRef(sites);
  const replayRef = useRef(replay);
  const annotateModeRef = useRef(annotateMode);
  const onAddRef = useRef(onAddAnnotation);
  const onCameraRef = useRef(onCamera);
  const basemapRef = useRef(basemap);
  const [loadError, setLoadError] = useState(null);

  // Data layers: layerId -> { data, store: Map(key -> {feature, sig}) }
  const dataLayersRef = useRef({});
  // Label markers that ride above the data layers (sites, annotations).
  const labelMarkersRef = useRef({}); // key -> marker
  const infoWinRef = useRef(null);

  useEffect(() => {
    onSelectRef.current = onSelect; onStatusRef.current = onStatus;
    regionRef.current = region; activeRef.current = activeLayers; sitesRef.current = sites;
    replayRef.current = replay;
    annotateModeRef.current = annotateMode; onAddRef.current = onAddAnnotation; onCameraRef.current = onCamera;
    basemapRef.current = basemap;
  });

  // ---- init (once) ----
  useEffect(() => {
    let cancelled = false;
    let timer;
    loadGoogleMaps().then((g) => {
      if (cancelled) return;
      googleRef.current = g;
      const map = new g.Map(containerRef.current, {
        center: { lat: -35.3081, lng: 149.1244 },
        zoom: 9,
        disableDefaultUI: true,
        gestureHandling: 'greedy',
        keyboardShortcuts: false,
        clickableIcons: false,
        streetViewControl: false,
        backgroundColor: '#0a0e14',
        // Vector renderer when a mapId is configured; raster roadmap otherwise
        // (styles are only honoured on the raster roadmap).
        ...(GMAPS_ID ? { mapId: GMAPS_ID } : { styles: DARK_STYLE }),
      });
      mapRef.current = map;
      if (typeof window !== 'undefined') window.__parallaxMap = map;

      applyBasemap(g, map, basemapRef.current);

      for (const layer of LAYERS) registerLayer(g, map, layer, onSelectRef, dataLayersRef, enabledRef);
      addTrailLayers(g, map, dataLayersRef, enabledRef);
      addOntologyLayer(g, map, dataLayersRef);
      addAnnotationLayer(g, map, onSelectRef, dataLayersRef);
      addAlertLayer(g, map, dataLayersRef);
      addDetectionLayer(g, map, dataLayersRef);
      readyRef.current = true;

      infoWinRef.current = new g.InfoWindow({ maxWidth: 300 });
      drawSites(g, map, sitesRef.current, labelMarkersRef, infoWinRef);

      // Annotate mode: a map click drops a human annotation.
      map.addListener('click', (e) => {
        if (annotateModeRef.current) {
          onAddRef.current && onAddRef.current([e.latLng.lng(), e.latLng.lat()]);
        }
      });
      // Report camera moves so a workspace can save/restore the view.
      map.addListener('idle', () => {
        const c = map.getCenter();
        if (c) onCameraRef.current && onCameraRef.current({ center: [c.lng(), c.lat()], zoom: map.getZoom() });
      });

      applyVisibility(map, enabledRef.current, dataLayersRef);

      refreshAll(map, onStatusRef, trailsRef, regionRef, activeRef, replayRef, dataLayersRef);
      timer = setInterval(() => refreshAll(map, onStatusRef, trailsRef, regionRef, activeRef, replayRef, dataLayersRef), REFRESH_MS);
    }).catch((err) => {
      if (!cancelled) setLoadError(String(err && err.message ? err.message : err));
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      const map = mapRef.current;
      if (map && googleRef.current && googleRef.current.event) googleRef.current.event.clearInstanceListeners(map);
      mapRef.current = null;
      readyRef.current = false;
      dataLayersRef.current = {};
      labelMarkersRef.current = {};
      trailsRef.current = {};
    };
  }, []);

  // ---- visibility follows `enabled` ----
  useEffect(() => {
    enabledRef.current = enabled;
    if (readyRef.current && mapRef.current) applyVisibility(mapRef.current, enabled, dataLayersRef);
  }, [enabled]);

  // ---- camera follows `command` ----
  useEffect(() => {
    const map = mapRef.current;
    if (command && command.center && map) {
      map.setZoom(command.zoom || 11);
      map.panTo({ lat: command.center[1], lng: command.center[0] });
      if (command.pitch != null && GMAPS_ID) {
        try { map.setTilt(Math.max(0, Math.min(60, command.pitch))); } catch { /* raster maps cap tilt */ }
      }
    }
  }, [command]);

  // ---- basemap follows `basemap` ----
  useEffect(() => {
    basemapRef.current = basemap;
    const map = mapRef.current;
    if (map && readyRef.current && googleRef.current) applyBasemap(googleRef.current, map, basemap);
  }, [basemap]);

  // ---- resolved ontology links follow `ontology` / `showLinks` ----
  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !readyRef.current) return;
    const entry = dataLayersRef.current['ontology-links'];
    if (!entry) return;
    const features = (ontology && ontology.links ? ontology.links : [])
      .filter((l) => l.fromCoord && l.toCoord)
      .map((l) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [l.fromCoord, l.toCoord] },
        properties: { confidence: l.confidence, type: l.type },
      }));
    syncDataLayer(g, entry, { type: 'FeatureCollection', features }, (f) => JSON.stringify(f.geometry.coordinates));
    entry.data.setStyle((f) => (!showLinks ? { visible: false } : ontologyLinkStyle(g, f)));
  }, [ontology, showLinks]);

  // ---- region switch: wipe every source + trail so old data doesn't linger ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    trailsRef.current = {};
    for (const layer of LAYERS) {
      const entry = dataLayersRef.current[layer.id];
      if (entry) { entry.data.forEach((f) => entry.data.remove(f)); entry.store.clear(); }
      const trail = dataLayersRef.current['trail-' + layer.id];
      if (trail) trail.data.forEach((f) => trail.data.remove(f));
    }
    const ol = dataLayersRef.current['ontology-links'];
    if (ol) { ol.data.forEach((f) => ol.data.remove(f)); ol.store.clear(); }
    clearLabelMarkers('annotation');
    clearLabelMarkers('site');
  }, [region]);

  // ---- fetch the active layers whenever the region's layer set changes ----
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) refreshAll(map, onStatusRef, trailsRef, regionRef, activeRef, replayRef, dataLayersRef);
  }, [activeLayers, region]);

  // ---- fixed-site markers follow the region ----
  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !readyRef.current) return;
    drawSites(g, map, sites || [], labelMarkersRef, infoWinRef);
  }, [sites]);

  // ---- human annotations follow the `annotations` prop ----
  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !readyRef.current) return;
    const entry = dataLayersRef.current['annotations'];
    if (!entry) return;
    const features = (annotations || []).map((a) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
      properties: { layer: 'annotation', title: a.label, label: a.label, note: a.note || '', id: a.id },
    }));
    syncDataLayer(g, entry, { type: 'FeatureCollection', features }, (f) => f.properties.id || JSON.stringify(f.geometry.coordinates));
    drawAnnotationLabels(g, map, annotations || [], labelMarkersRef);
  }, [annotations]);

  // ---- crosshair cursor while annotating ----
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) map.setOptions({ draggableCursor: annotateMode ? 'crosshair' : '' });
  }, [annotateMode]);

  // ---- alert rings follow `alerts` ----
  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !readyRef.current) return;
    const entry = dataLayersRef.current['alerts'];
    if (!entry) return;
    const features = (alerts || []).filter((a) => a.coord).map((a) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: a.coord },
      properties: { label: a.label, id: a.id },
    }));
    syncDataLayer(g, entry, { type: 'FeatureCollection', features }, (f) => f.properties.id || JSON.stringify(f.geometry.coordinates));
  }, [alerts]);

  // ---- object-detection markers follow `detections` ----
  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !readyRef.current) return;
    const entry = dataLayersRef.current['detections'];
    if (!entry) return;
    const features = (detections || []).filter((d) => d.coord).map((d) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: d.coord },
      properties: {
        id: d.id, label: d.class || 'detection', class: d.class, score: d.score,
        source: d.source || 'vision', sourceId: d.sourceId || '', detectedAt: d.detected_at_ms || Date.now(),
      },
    }));
    syncDataLayer(g, entry, { type: 'FeatureCollection', features }, (f) => f.properties.id || JSON.stringify(f.geometry.coordinates));
  }, [detections]);

  // ---- replay: show historical frames; restore live when it ends ----
  useEffect(() => {
    const g = googleRef.current;
    const map = mapRef.current;
    if (!g || !map || !readyRef.current) return;
    if (replay) {
      for (const layer of LAYERS) {
        const entry = dataLayersRef.current[layer.id];
        if (entry) {
          const fc = (replayFrames && replayFrames[layer.id]) || emptyFC();
          syncDataLayer(g, entry, fc, (f) => featureKey(layer.id, f));
        }
        const trail = dataLayersRef.current['trail-' + layer.id];
        if (trail) trail.data.forEach((f) => trail.data.remove(f)); // trails are a live-only concept
      }
    } else {
      trailsRef.current = {};
      refreshAll(map, onStatusRef, trailsRef, regionRef, activeRef, replayRef, dataLayersRef);
    }
  }, [replay, replayFrames]);

  const mapIsDark = basemap === 'dark';

  return (
    <div className="map-wrap">
      <div className="map-root" ref={containerRef} />
      {loadError ? (
        renderMapError(loadError)
      ) : (
        <div className="basemap-switch" role="group" aria-label="Basemap">
          {BASEMAPS.map((b) => (
            <button
              key={b.id}
              className={'basemap-btn' + (basemap === b.id ? ' on' : '')}
              onClick={() => onBasemapChange && onBasemapChange(b.id)}
              title={b.id === 'satellite' || b.id === 'hybrid' ? 'Google satellite imagery' : b.label + ' basemap'}
            >
              {b.id === 'dark' ? 'Dark' : b.id === 'satellite' ? 'Sat' : b.id === 'hybrid' ? 'Sat+'
                : b.id === 'terrain' ? 'Terrain' : 'Map'}
            </button>
          ))}
        </div>
      )}
      <span className={'gmap-hint' + (mapIsDark ? '' : ' light')}>Google Maps{GMAPS_ID ? ' · vector' : ''}</span>
    </div>
  );
}

function renderMapError(msg) {
  return (
    <div className="map-error">
      <div className="map-error-card">
        <div className="map-error-title">Google Maps is not configured</div>
        <p>{msg}</p>
        <p>
          Set <code>NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> in <code>.env.local</code> (Maps JavaScript API,
          with your site's domain allowed) and restart <code>npm run dev</code>.
          Optionally set <code>NEXT_PUBLIC_GOOGLE_MAPS_ID</code> to a vector map id for dark mode and tilt.
        </p>
      </div>
    </div>
  );
}

function applyBasemap(g, map, bm) {
  try {
    if (bm === 'satellite') map.setMapTypeId('satellite');
    else if (bm === 'hybrid') map.setMapTypeId('hybrid');
    else if (bm === 'terrain') map.setMapTypeId('terrain');
    else {
      map.setMapTypeId('roadmap');
      if (GMAPS_ID) {
        map.setOptions({ colorScheme: bm === 'dark' ? 'DARK' : 'LIGHT' });
      } else {
        map.setOptions({ styles: bm === 'dark' ? DARK_STYLE : [] });
      }
    }
  } catch (err) {
    console.error('[gmaps] basemap switch failed', err);
  }
}

// ---------------------------------------------------------------- layers
function registerLayer(g, map, layer, onSelectRef, layersRef, enabledRef) {
  const data = new g.Data({ map });
  data.setStyle((f) => {
    if (!enabledRef.current.has(layer.id)) return { visible: false };
    return contactStyle(g, layer, f);
  });
  data.addListener('click', (e) => {
    const f = e.feature;
    const p = {};
    f.forEachProperty((v, k) => { p[k] = v; });
    const rows = ((RENDERERS[layer.id] && RENDERERS[layer.id](p)) || []).filter(([k, v]) => v != null && v !== '');
    const geom = f.getGeometry();
    onSelectRef.current && onSelectRef.current({
      layer,
      properties: p,
      rows,
      coord: geom && geom.getType() === 'Point' ? [geom.get().lng(), geom.get().lat()] : null,
    });
    const gmap = window.__parallaxMap;
    if (gmap && window.google && window.google.maps) {
      const iw = window.__philotasInfoWin || (window.__philotasInfoWin = new window.google.maps.InfoWindow({ maxWidth: 300 }));
      const pos = geom.getType() === 'Point' ? geom.get() : geom.getAt(0);
      iw.setContent('<div class="gm-pop"><h4 style="color:' + layer.color + '">' + (p.title || '') + '</h4>' +
        rows.slice(0, 5).map(([k, v]) => '<div class="pop-row"><span class="k">' + k + '</span><span>' + v + '</span></div>').join('') + '</div>');
      iw.setPosition(pos);
      iw.open({ map: gmap });
    }
  });
  layersRef.current[layer.id] = { data, store: new Map(), layer };
}

function contactStyle(g, layer, f) {
  const p = {};
  f.forEachProperty((v, k) => { p[k] = v; });
  if (layer.type === 'aircraft') {
    return {
      icon: {
        path: g.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 4,
        rotation: Number(p.heading) || 0,
        fillColor: layer.color, fillOpacity: 0.95,
        strokeColor: '#000', strokeWeight: 0.8,
      },
    };
  }
  if (layer.type === 'vessel') {
    const colors = { passenger: '#7EF9FF', cruise: '#A78BFA', cargo: '#3FA2E8', tanker: '#F59E0B', tug: '#8B81FF', naval: '#EF4444', pilot: '#4FC1F0', pleasure: '#9FB2CC' };
    const scales = { cruise: 16, cargo: 14, tanker: 14, naval: 14, passenger: 10, tug: 8, pilot: 8, pleasure: 6 };
    const color = colors[p.ship_type] || '#7E93AD';
    const scale = scales[p.ship_type] != null ? scales[p.ship_type] : 10;
    // Three states, each visually distinct (same semantics as the MapLibre
    // renderer this replaced): not reporting -> red ring hollow; expected ->
    // cyan ring hollow; present -> filled.
    const ring = p.reporting === false ? '#EF4444' : p.expected ? '#7EF9FF' : '#0B1B33';
    const ringW = p.reporting === false ? 3 : p.expected ? 2 : 1.5;
    const opacity = p.reporting === false ? 0.25 : p.expected ? 0.12 : 0.9;
    return { icon: { path: g.SymbolPath.CIRCLE, scale, fillColor: color, fillOpacity: opacity, strokeColor: ring, strokeWeight: ringW } };
  }
  if (layer.type === 'quake') {
    const mag = Number(p.magnitude) || 1;
    const scale = Math.min(44, Math.max(6, 6 + (mag / 6) * 38));
    return { icon: { path: g.SymbolPath.CIRCLE, scale, fillColor: layer.color, fillOpacity: 0.35, strokeColor: layer.color, strokeWeight: 1.5 } };
  }
  // 'circle' and 'vehicle' both render as dots.
  return {
    icon: {
      path: g.SymbolPath.CIRCLE,
      scale: (layer.radius || 5) * 2,
      fillColor: layer.color, fillOpacity: 0.85,
      strokeColor: '#0a0e14', strokeWeight: 1.5,
    },
  };
}

function ontologyLinkStyle(g, f) {
  const conf = Number(f.getProperty('confidence')) || 0.5;
  const color = conf < 0.3 ? '#7E93AD' : conf < 0.7 ? '#5D4FFF' : '#7EF9FF';
  const weight = conf < 0.3 ? 0.5 : 1 + conf * 0.3;
  return { strokeColor: color, strokeWeight: weight, strokeOpacity: conf < 0.3 ? 0.22 : 0.45 };
}

function addTrailLayers(g, map, layersRef, enabledRef) {
  for (const layer of LAYERS) {
    if (!layer.trail) continue;
    const id = 'trail-' + layer.id;
    const data = new g.Data({ map });
    data.setStyle((f) => {
      if (!enabledRef.current.has(layer.id)) return { visible: false };
      return { strokeColor: layer.color, strokeWeight: 1.5, strokeOpacity: 0.4 };
    });
    layersRef.current[id] = { data, store: new Map(), trail: true };
  }
}

function addOntologyLayer(g, map, layersRef) {
  const data = new g.Data({ map });
  data.setStyle((f) => ontologyLinkStyle(g, f));
  layersRef.current['ontology-links'] = { data, store: new Map(), links: true };
}

// Human annotations: a distinct yellow marker + label, clickable for the note.
function addAnnotationLayer(g, map, onSelectRef, layersRef) {
  const data = new g.Data({ map });
  data.setStyle(() => ({
    icon: { path: g.SymbolPath.CIRCLE, scale: 12, fillColor: '#facc15', fillOpacity: 1, strokeColor: '#1a1205', strokeWeight: 2 },
  }));
  data.addListener('click', (e) => {
    const f = e.feature;
    const p = {};
    f.forEachProperty((v, k) => { p[k] = v; });
    const geom = f.getGeometry();
    onSelectRef.current && onSelectRef.current({
      layer: { color: '#facc15', label: 'Annotation' },
      properties: { title: p.label },
      rows: [['type', 'human annotation'], ['note', p.note || '—']],
      coord: geom && geom.getType() === 'Point' ? [geom.get().lng(), geom.get().lat()] : null,
    });
  });
  layersRef.current['annotations'] = { data, store: new Map(), annotations: true };
}

function drawAnnotationLabels(g, map, annotations, labelMarkersRef) {
  clearLabelMarkers('annotation');
  for (const a of annotations || []) {
    const m = new g.Marker({
      map,
      position: { lat: a.lat, lng: a.lng },
      label: { text: a.label || 'Marker', color: '#facc15', fontSize: '10px', className: 'gm-ann-label' },
      clickable: false,
    });
    labelMarkersRef.current['annotation-' + a.id] = m;
  }
}

function clearLabelMarkers(prefix) {
  for (const key of Object.keys(labelMarkersRef.current)) {
    if (key.startsWith(prefix)) {
      labelMarkersRef.current[key].setMap(null);
      delete labelMarkersRef.current[key];
    }
  }
}

// Rule-triggered alerts: a bright red ring around the offending entity.
function addAlertLayer(g, map, layersRef) {
  const data = new g.Data({ map });
  data.setStyle(() => ({
    icon: { path: g.SymbolPath.CIRCLE, scale: 28, fillColor: 'rgba(239,68,68,0.12)', fillOpacity: 1, strokeColor: '#ef4444', strokeWeight: 2.5 },
  }));
  layersRef.current['alerts'] = { data, store: new Map(), alerts: true };
}

// Object detections: an orange ring, distinct from alerts (red) and annotations
// (yellow). Clickable for the detection detail.
function addDetectionLayer(g, map, layersRef) {
  const data = new g.Data({ map });
  data.setStyle(() => ({
    icon: { path: g.SymbolPath.CIRCLE, scale: 20, fillColor: 'rgba(251,146,60,0.2)', fillOpacity: 1, strokeColor: '#fb923c', strokeWeight: 2 },
  }));
  data.addListener('click', (e) => {
    const f = e.feature;
    const p = {};
    f.forEachProperty((v, k) => { p[k] = v; });
    const gmap = window.__parallaxMap;
    if (gmap && window.google && window.google.maps) {
      const iw = window.__philotasInfoWin || (window.__philotasInfoWin = new window.google.maps.InfoWindow({ maxWidth: 300 }));
      iw.setContent(
        '<div class="gm-pop"><h4 style="color:#fb923c">Detection: ' + (p.class || 'object') + '</h4>' +
        '<div class="pop-row"><span class="k">confidence</span><span>' + Math.round((p.score || 0) * 100) + '%</span></div>' +
        '<div class="pop-row"><span class="k">source</span><span>' + (p.source || 'vision') + '</span></div>' +
        '</div>'
      );
      iw.setPosition(f.getGeometry().get());
      iw.open({ map: gmap });
    }
  });
  layersRef.current['detections'] = { data, store: new Map(), detections: true };
}

// Fixed sites: labelled markers with a popup.
function drawSites(g, map, sites, labelMarkersRef, infoWinRef) {
  clearLabelMarkers('site');
  for (const site of sites || []) {
    const m = new g.Marker({
      map,
      position: { lat: site.coord[1], lng: site.coord[0] },
      label: { text: site.name, color: '#5b6b82', fontSize: '9px', className: 'gm-site-label' },
      icon: {
        path: g.SymbolPath.CIRCLE,
        scale: 5,
        fillColor: '#5b6b82', fillOpacity: 1,
        strokeColor: '#0a0e14', strokeWeight: 1,
      },
    });
    m.addListener('click', () => {
      if (infoWinRef.current) {
        infoWinRef.current.setContent('<div class="gm-pop"><h4 style="color:#5b6b82">' + site.name + '</h4><div class="muted">' + site.kind + '</div></div>');
        infoWinRef.current.open({ map, anchor: m });
      }
    });
    labelMarkersRef.current['site-' + site.id] = m;
  }
}
// ---------------------------------------------------------------- data sync
function featureKey(layerId, f) {
  const p = f.properties || {};
  return p.id || trailKey(layerId, p) || (f.geometry ? JSON.stringify(f.geometry.coordinates) : '');
}

function sigOf(f) {
  return JSON.stringify(f.geometry ? f.geometry.coordinates : null) + '|' + JSON.stringify(f.properties || {});
}

// Incremental sync: unchanged features are left alone (no flicker), changed
// features are replaced, stale features removed. Full re-adds per poll were
// fine at the MapLibre renderer's scale, but Google's Data layer re-shapes its
// feature set on each addGeoJson, so keep it diff-based.
function syncDataLayer(g, entry, fc, keyFn) {
  const data = entry.data;
  const store = entry.store;
  const seen = new Map();
  for (const f of fc.features || []) {
    const key = keyFn(f) || sigOf(f);
    if (!key) continue;
    const sig = sigOf(f);
    seen.set(key, f);
    const prev = store.get(key);
    if (prev && prev.sig === sig) continue;
    if (prev) data.remove(prev.feature);
    const added = data.addGeoJson(f);
    store.set(key, { feature: added[0], sig });
  }
  for (const [key, rec] of store) {
    if (!seen.has(key)) { data.remove(rec.feature); store.delete(key); }
  }
}

// ---- trails: keep a short rolling history of each moving contact ----
function updateTrail(g, map, layer, fc, trails, layersRef) {
  const store = trails[layer.id] || (trails[layer.id] = new Map());
  const seen = new Set();
  for (const f of fc.features || []) {
    const key = trailKey(layer.id, f.properties);
    const c = f.geometry && f.geometry.coordinates;
    if (!key || !c) continue;
    seen.add(key);
    const rec = store.get(key) || { coords: [], missed: 0 };
    const last = rec.coords[rec.coords.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) rec.coords.push(c);
    if (rec.coords.length > 25) rec.coords.shift();
    rec.missed = 0;
    store.set(key, rec);
  }
  for (const [key, rec] of store) if (!seen.has(key) && ++rec.missed > 8) store.delete(key);

  const features = Array.from(store.values()).filter((r) => r.coords.length > 1)
    .map((r) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: r.coords }, properties: {} }));
  const entry = layersRef['trail-' + layer.id];
  if (entry) {
    entry.data.forEach((f) => entry.data.remove(f));
    if (features.length) entry.data.addGeoJson({ type: 'FeatureCollection', features });
  }
}

function applyVisibility(map, enabled, layersRef) {
  const set = new Set(enabled);
  const g = window.google && window.google.maps;
  for (const layer of LAYERS) {
    const entry = layersRef[layer.id];
    if (entry && g) entry.data.setStyle((f) => {
      if (!set.has(layer.id)) return { visible: false };
      return contactStyle(g, layer, f);
    });
    const trail = layersRef['trail-' + layer.id];
    if (trail) trail.data.setStyle((f) => {
      if (!set.has(layer.id)) return { visible: false };
      return { strokeColor: layer.color, strokeWeight: 1.5, strokeOpacity: 0.4 };
    });
  }
}

async function refreshAll(map, onStatusRef, trails, regionRef, activeRef, replayRef, layersRef) {
  if (replayRef && replayRef.current) return; // frozen on a historical frame
  const g = window.google && window.google.maps;
  const region = regionRef.current;
  const active = new Set(activeRef.current || []);
  const status = {};
  await Promise.all(LAYERS.map(async (layer) => {
    if (!active.has(layer.id)) {
      // Not part of this region — make sure any prior data is cleared.
      const entry = layersRef[layer.id];
      if (entry) { entry.data.forEach((f) => entry.data.remove(f)); entry.store.clear(); }
      return;
    }
    try {
      const fc = await (await fetch('/api/feeds/' + layer.id + '?region=' + region)).json();
      const entry = layersRef[layer.id];
      if (entry && g) {
        syncDataLayer(g, entry, fc.type ? fc : emptyFC(), (f) => featureKey(layer.id, f));
        if (layer.trail) updateTrail(g, map, layer, fc, trails, layersRef);
      }
      // `source` and `notice` ride along from the feed payload so a degraded
      // layer can declare itself — camera sites with no imagery, hotspots with
      // no FIRMS key, an empty vessel picture.
      status[layer.id] = {
        count: fc.count != null ? fc.count : 0,
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
  onStatusRef.current && onStatusRef.current(status);
}

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
