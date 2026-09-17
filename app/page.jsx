'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { LAYERS } from '@/lib/layers';
import { getJson } from '@/lib/fetch-json';
import { feedLiveness, splitContactCounts } from '@/lib/feed-health';
import { groupRegionsByTheatre, regionOptionLabel } from '@/lib/region-groups';
import { shouldShowChooser, FEATURED_REGION_IDS, FEATURED_REGION_LABELS, PREFERRED_REGION_KEY } from '@/lib/trial-chooser';

import KnowledgePanel from '@/components/KnowledgePanel';
import MiniGraph from '@/components/MiniGraph';

// MapLibre touches `window` at import, so the map is client-only.
const MapView = dynamic(() => import('@/components/MapView'), { ssr: false });

const CLASSES = ['UNCLASSIFIED', 'OFFICIAL', 'SECRET', 'TOP SECRET'];
const CLASS_COLOR = ['#34d399', '#38bdf8', '#f59e0b', '#ef4444'];
// Must match GUEST_USERNAME in app/api/auth/guest/route.js.
const TRIAL_USERNAME = 'trial';
// Map a selected map contact onto the ontology's entity key. Must stay in step
// with TYPE_OF in lib/ontology/build.js — a mismatch silently yields no intel
// rather than an error, which is the hard kind of bug to notice.
const ENTITY_TYPE_BY_LAYER = {
  vessels: 'Vessel', berths: 'Berth', facilities: 'Facility', aviation: 'Aircraft',
  satellites: 'Satellite', fires: 'FireIncident', seismic: 'Earthquake',
  space: 'GroundStation', hotspots: 'Hotspot', news: 'NewsArticle',
};

// How much wall clock the replay actually covers, said plainly. The bar used to
// report a frame count, which tells an operator nothing about how far back they
// can look — 240 frames is two hours or twenty minutes depending on the cadence.
// Human layer names for the notices, taken from the layer registry so the
// banner cannot drift from what the layer panel calls the same thing.
const FEED_LABEL = Object.fromEntries(LAYERS.map((l) => [l.id, l.label]));

// How long ago, stated in the largest unit that is still specific. An operator
// looking at recorded data needs the age more than the timestamp.
function formatAgo(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// The replay window as an operator would say it out loud. The end is called
// "now" when it is within a couple of minutes of now, because that is what it
// means — the window slides, it is not a fixed historical extract.
function formatWindow(startMs, endMs) {
  const opts = { weekday: 'short', hour: '2-digit', minute: '2-digit' };
  const start = new Date(startMs).toLocaleString(undefined, opts);
  const atNow = Date.now() - endMs < 2 * 60 * 1000;
  return `${start} → ${atNow ? 'now' : new Date(endMs).toLocaleString(undefined, opts)}`;
}

function formatSpan(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export default function Page() {
  // Land on the flagship build already moving, not on a globe to navigate.
  const [region, setRegion] = useState('sydney');
  // Seeded with the theatre it really has, so the one frame before /api/regions
  // answers shows Sydney under "Australia & NZ" rather than under "Other".
  const [regions, setRegions] = useState([
    { id: 'sydney', name: 'Sydney', type: 'city', country: 'AU', theatre: 'Australia & NZ' },
  ]);
  const [ctx, setCtx] = useState({ center: [151.228, -33.856], zoom: 11.5, sites: [], layers: [], arc: [], name: 'Sydney' });
  const [enabled, setEnabled] = useState([]);
  const [status, setStatus] = useState({});
  const [selection, setSelection] = useState(null);
  const [command, setCommand] = useState(null);
  const [arcIdx, setArcIdx] = useState(0);
  const [clock, setClock] = useState('--:--:--');
  const [ontology, setOntology] = useState(null);
  const [showLinks, setShowLinks] = useState(true);
  const [replay, setReplay] = useState(false);
  const [framesByLayer, setFramesByLayer] = useState({});
  const [timeline, setTimeline] = useState([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  // The span of the loaded replay window, the window itself, how far the
  // archive actually reaches, and whether a window fetch is in flight. The
  // archive is 48 hours; the browser holds one window of it at a time.
  const [replaySpanMs, setReplaySpanMs] = useState(60 * 60 * 1000);
  const [replayWindow, setReplayWindow] = useState(null);
  const [archiveExtent, setArchiveExtent] = useState(null);
  const [windowLoading, setWindowLoading] = useState(false);
  const [annotations, setAnnotations] = useState([]);
  const [annotateMode, setAnnotateMode] = useState(false);
  const [workspaces, setWorkspaces] = useState({});
  // True when this session came from the public trial door rather than a real
  // sign-in. Surfaced so a visitor knows what they are looking at.
  const [trialSession, setTrialSession] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [chooserSearch, setChooserSearch] = useState('');
  // Every read route requires a session. Data effects must therefore not fire
  // until auth has resolved, or they race the trial sign-in, get 401, and leave
  // the map with no layers to fetch -- which looked like "open it twice".
  // This gates them rather than leaving the ordering to chance.
  const [authReady, setAuthReady] = useState(false);
  const [wsName, setWsName] = useState('');
  const [user, setUser] = useState(null);
  const [authUser, setAuthUser] = useState('');
  const [authPass, setAuthPass] = useState('');
  const [authErr, setAuthErr] = useState('');
  const [serverWs, setServerWs] = useState([]);
  const [wsShared, setWsShared] = useState(false);
  const [wsClass, setWsClass] = useState(0);
  const [wsAllocate, setWsAllocate] = useState('');
  const [auditLog, setAuditLog] = useState([]);
  const [usersList, setUsersList] = useState([]);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [rules, setRules] = useState([]);
  const [actions, setActions] = useState([]);
  const [ruleForm, setRuleForm] = useState({ name: '', layer: '', field: '', op: 'gte', value: '' });
  // Which Google basemap the map shows. Default is the dark-styled roadmap so
  // the switch to Google does not also change the product's colour temperature;
  // satellite / hybrid are one tap away on the map's own switcher.
  const [basemap, setBasemap] = useState('dark');
  const [graphOpen, setGraphOpen] = useState(false);
  // ---- vision (object detection) ----
  const [detections, setDetections] = useState([]);
  const [detHealth, setDetHealth] = useState(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionMsg, setVisionMsg] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoCoord, setVideoCoord] = useState('');
  // Detections overlaid on the selected contact's image (camera still / upload).
  const [imageDets, setImageDets] = useState([]);
  // Ranked "find other instances" results for the selected detection.
  const [similar, setSimilar] = useState([]);
  // ---- workflows ----
  const [workflows, setWorkflows] = useState([]);
  const [wfForm, setWfForm] = useState({ name: '', classes: 'person, bicycle, car', minScore: '0.5', withinMin: '5', minDetections: '1', webhook: '' });
  const [caseFiles, setCaseFiles] = useState([]);
  const [openCase, setOpenCase] = useState(null);
  const [intel, setIntel] = useState(null);
  const [intelLoading, setIntelLoading] = useState(false);
  // Which panel is showing as the bottom sheet on a phone. Above the phone
  // breakpoint this is inert: `.mobile-open` carries no rules outside the media
  // query, so the desktop panels are on screen regardless of what this holds.
  const [mobileSheet, setMobileSheet] = useState(null);
  const seqRef = useRef(0);
  const cameraRef = useRef(null);
  const pendingWsRef = useRef(null);

  // Region list for the switcher. Gated on auth: see the note on authReady.
  useEffect(() => {
    if (!authReady) return;
    fetch('/api/regions').then((r) => r.json()).then((d) => setRegions(d.regions || [])).catch(() => {});
  }, [authReady]);

  // Deep-link: ?region=<id>&basemap=satellite&lng=&lat=&zoom= sets the initial view.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const r = p.get('region'); if (r) setRegion(r);
    const bm = p.get('basemap'); if (bm) setBasemap(bm);
    if (p.get('graph') === '1') setGraphOpen(true);
    const lng = +p.get('lng'); const lat = +p.get('lat'); const z = +p.get('zoom');
    if (lng && lat) setTimeout(() => setCommand({ seq: ++seqRef.current, center: [lng, lat], zoom: z || 14, pitch: 0 }), 900);
  }, []);

  // Cold-landing chooser. Only when the URL carries no view and nothing was
  // chosen before: a deep-link wins, and a returning visitor lands on their
  // city without being asked again.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const hasViewParam = p.has('region') || p.has('lng') || p.has('lat') || p.has('basemap');
    let preferred = null;
    try { preferred = localStorage.getItem(PREFERRED_REGION_KEY); } catch { /* ignore */ }
    // A stored preference restores the returning visitor's city only when the
    // URL carries no view. When the URL names a view the deep-link effect above
    // sets the region and wins; the preference is ignored entirely, because
    // both mount effects flush in order into one re-render and an unconditional
    // setRegion here would overwrite the deep-link.
    if (preferred && !hasViewParam) setRegion(preferred);
    if (shouldShowChooser({ hasViewParam, preferredRegion: preferred })) setChooserOpen(true);
  }, []);

  // A city picked in the chooser is remembered for next time (see the cold-landing
  // effect above) and drives the map immediately — no reload, no re-ask.
  function chooseRegion(id) {
    try { localStorage.setItem(PREFERRED_REGION_KEY, id); } catch { /* ignore */ }
    setRegion(id);
    setChooserOpen(false);
    setChooserSearch('');
  }

  // Persist the basemap choice across visits.
  useEffect(() => {
    try { localStorage.setItem('philotas.basemap', basemap); } catch { /* ignore */ }
  }, [basemap]);
  // Restore it on first mount (deep-link ?basemap= wins: it is set by the
  // effect above and this one only seeds the initial state).
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      if (p.has('basemap')) return;
      const saved = localStorage.getItem('philotas.basemap');
      if (saved) setBasemap(saved);
    } catch { /* ignore */ }
  }, []);

  // Saved workspaces (localStorage).
  useEffect(() => {
    try { const raw = localStorage.getItem('parallax.workspaces'); if (raw) setWorkspaces(JSON.parse(raw)); } catch { /* ignore */ }
  }, []);

  // Load the region's context (centre, sites, active layers, arc) and re-aim.
  // If a workspace load is pending for this region, apply its saved view instead.
  useEffect(() => {
    if (!authReady) return;
    setSelection(null);
    fetch(`/api/context?region=${region}`).then((r) => {
      // A 401 here used to be written straight into ctx as an error object,
      // leaving layers undefined and the map with nothing to fetch.
      if (!r.ok) throw new Error(`context ${r.status}`);
      return r.json();
    }).then((data) => {
      setCtx(data);
      setArcIdx(0);
      const ws = pendingWsRef.current;
      if (ws && ws.region === region) {
        setEnabled(ws.enabled || data.layers || []);
        setAnnotations(ws.annotations || []);
        setCommand({ seq: ++seqRef.current, center: ws.camera?.center || data.center, zoom: ws.camera?.zoom ?? data.zoom, pitch: 0 });
        pendingWsRef.current = null;
      } else {
        // News on by default. It used to be off for every region but `world`,
        // because pre-GKG the layer was 60 articles spiralled around the region
        // centroid — decoration, not information — and the Knowledge panel was
        // the honest place to read it. Both halves of that changed: every
        // article now carries its own geocode, and the catchment is wider than
        // the map box, so some of what a region matches is filed next door and
        // invisible unless the layer is on. Scoring one 409-record GKG file
        // against 64 candidate boxes, run 2 drew 91 records at the metro map box
        // of 0.6 x 0.5 degrees and 389 at 2.5 x 2.0
        // (docs/measurements/2026-08-16-region-coverage-probe-run2.txt). All 64
        // of those boxes are metro or chokepoint scale, so the shipped catchment
        // is NEWS_CATCHMENT_MULTIPLE = 3 times the half-extent for `city` and
        // `strait` regions only; the country and multi-country views take their
        // own map bbox, because nothing was ever scored at continental scale —
        // see the note in lib/regions.js. The Knowledge panel is still the
        // searchable surface; the map is where you see that the story is filed
        // next door.
        setEnabled(data.layers || []);
        setCommand({ seq: ++seqRef.current, center: data.center, zoom: data.zoom, pitch: 0 });
      }
    }).catch(() => {});
  }, [region, authReady]);

  // Poll the AI ontology pass for this region.
  useEffect(() => {
    if (!authReady) return;
    setOntology(null);
    const pull = () => getJson(`/api/ontology?region=${region}`).then(setOntology).catch(() => {});
    pull();
    const t = setInterval(pull, 20_000);
    return () => clearInterval(t);
  }, [region, authReady]);

  // AEST clock.
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour12: false }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // Debounced search across the region's live entities + their ontology links.
  useEffect(() => {
    if (searchQ.trim().length < 2) { setSearchResults([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/search?region=${region}&q=${encodeURIComponent(searchQ)}`)
        .then((r) => r.json()).then((j) => setSearchResults(j.results || [])).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ, region]);

  function flyToResult(r) {
    if (r.coord) setCommand({ seq: ++seqRef.current, center: r.coord, zoom: region === 'world' ? 5 : 12 });
  }

  // Case files: confirmed events with recorded frames, openable on demand.
  // This is what stops the trial depending on the harbour being interesting
  // during the ninety seconds a visitor happens to be watching.
  useEffect(() => {
    if (!authReady) return;
    const pull = () => getJson(`/api/casefiles?region=${region}`)
      .then((j) => setCaseFiles(j.files || [])).catch(() => setCaseFiles([]));
    pull();
    const t = setInterval(pull, 60_000);
    return () => clearInterval(t);
  }, [region, authReady]);

  // Open a case file: load its recorded frames into the existing replay
  // machinery and fly to it. Reuses replay rather than duplicating it, so a
  // case file is simply a bookmarked moment.
  async function openCaseFile(file) {
    try {
      const j = await getJson(`/api/casefiles/${encodeURIComponent(file.id)}?region=${region}`);
      const frames = j.frames || {};
      const ts = [...new Set(Object.values(frames).flatMap((fr) => fr.map((f) => f.t)))].sort((a, b) => a - b);
      if (ts.length) {
        setFramesByLayer(frames);
        setTimeline(ts);
        setFrameIdx(0);
        setPlaying(true);
        setReplay(true);
      }
      setOpenCase(j.file || file);
      if (file.position) setCommand({ seq: ++seqRef.current, center: file.position, zoom: 13 });
    } catch { /* leave the list as it was */ }
  }

  // Open-source intelligence for the selected contact.
  useEffect(() => {
    const type = ENTITY_TYPE_BY_LAYER[selection?.layer?.id];
    const label = selection?.properties?.title;
    if (!authReady || !type || !label) { setIntel(null); return; }
    let cancelled = false;
    setIntelLoading(true);
    getJson(`/api/intel?region=${region}&key=${encodeURIComponent(`${type}:${label}`)}&type=${type}&label=${encodeURIComponent(label)}`)
      .then((j) => { if (!cancelled) setIntel(j); })
      .catch(() => { if (!cancelled) setIntel(null); })
      .finally(() => { if (!cancelled) setIntelLoading(false); });
    return () => { cancelled = true; };
  }, [selection, region, authReady]);

  // Poll rule-triggered alerts for the region.
  useEffect(() => {
    if (!authReady) return;
    const pull = () => fetch(`/api/alerts?region=${region}`).then((r) => r.json()).then((j) => setAlerts(j.alerts || [])).catch(() => {});
    pull();
    const t = setInterval(pull, 12_000);
    return () => clearInterval(t);
  }, [region, authReady]);

  // ---- vision (object detection) ----
  // Service health + recent detections for the region.
  useEffect(() => {
    if (!authReady) return;
    const pull = () => {
      getJson('/api/detection/health').then(setDetHealth).catch(() => setDetHealth({ ok: false, error: 'detection service unreachable' }));
      getJson(`/api/detections?region=${region}`).then((j) => setDetections(j.detections || [])).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 30_000);
    return () => clearInterval(t);
  }, [region, authReady]);

  // Clear per-image detection state when the selection changes.
  useEffect(() => { setImageDets([]); setSimilar([]); }, [selection]);

  async function runDetect(body, { withSource } = {}) {
    setVisionBusy(true);
    setVisionMsg('detecting…');
    try {
      const res = await fetch('/api/detection/detect', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'detection failed');
      setVisionMsg('');
      // The route re-lists what it stored; refresh the panel's own list too.
      if (withSource) getJson(`/api/detections?region=${region}`).then((d) => setDetections(d.detections || [])).catch(() => {});
      return j;
    } catch (err) {
      setVisionMsg(String(err.message || err));
      return { detections: [] };
    } finally {
      setVisionBusy(false);
    }
  }

  // Scan every live camera in the region and record what the model sees.
  async function scanCameras() {
    setVisionBusy(true);
    setVisionMsg('scanning region cameras…');
    try {
      const res = await fetch('/api/detection/scan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'scan failed');
      setVisionMsg(`scanned ${j.cameras || 0} cameras · ${j.detections || 0} detections`);
      getJson(`/api/detections?region=${region}`).then((d) => setDetections(d.detections || [])).catch(() => {});
    } catch (err) {
      setVisionMsg(String(err.message || err));
    } finally {
      setVisionBusy(false);
    }
  }

  // Detect on the selected contact's image (camera still or uploaded frame).
  async function detectSelectionImage() {
    const img = selection?.properties?.image;
    if (!img) return;
    const j = await runDetect({
      image: img,
      source: 'camera', sourceId: selection.properties.title || 'camera',
      coord: selection.coord, region,
    }, { withSource: true });
    setImageDets(j.detections || []);
  }

  // "Find other instances of this": rank other camera stills by similarity to
  // the selected detection's crop. The crop is the query image bounding box on
  // the camera still we just ran detection over.
  async function findSimilarFor(det) {
    const img = selection?.properties?.image;
    if (!img) return;
    setVisionBusy(true);
    setVisionMsg('searching other cameras…');
    setSimilar([]);
    try {
      const cams = await getJson(`/api/feeds/cameras?region=${region}`);
      const candidates = (cams.features || [])
        .filter((f) => f.properties?.image && f.properties.image !== img)
        .map((f) => ({ id: f.properties.title || 'camera', image: f.properties.image, coord: f.geometry?.coordinates }))
        .slice(0, 40);
      if (!candidates.length) { setVisionMsg('no other camera stills to compare'); return; }
      const res = await fetch('/api/detection/similar', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: img, bbox: det.bbox || null, candidates }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'search failed');
      setSimilar(j.matches || []);
      setVisionMsg(`${(j.matches || []).length} other instances ranked`);
    } catch (err) {
      setVisionMsg(String(err.message || err));
    } finally {
      setVisionBusy(false);
    }
  }

  // Scan a video feed URL: frames are sampled server-side, detections stored.
  async function scanVideo() {
    const url = videoUrl.trim();
    if (!url) { setVisionMsg('enter a video feed URL'); return; }
    setVisionBusy(true);
    setVisionMsg('sampling video feed…');
    try {
      // Optional map anchor so the video's detections plot somewhere sensible.
      let coord = null;
      if (videoCoord.trim()) {
        const [lng, lat] = videoCoord.split(',').map((s) => Number(s.trim()));
        if (Number.isFinite(lng) && Number.isFinite(lat)) coord = [lng, lat];
      }
      const res = await fetch('/api/detection/video', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, coord, region }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'video scan failed');
      setVisionMsg(`${j.frames || 0} frames · ${j.detections || 0} detections`);
      getJson(`/api/detections?region=${region}`).then((d) => setDetections(d.detections || [])).catch(() => {});
    } catch (err) {
      setVisionMsg(String(err.message || err));
    } finally {
      setVisionBusy(false);
    }
  }

  // Uploaded image: detect at the current map centre so the result can plot.
  async function uploadImage(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const j = await runDetect({
        image: String(reader.result),
        source: 'upload', sourceId: file.name,
        coord: cameraRef.current?.center || ctx.center,
        region,
      }, { withSource: true });
      setImageDets(j.detections || []);
    };
    reader.readAsDataURL(file);
  }

  // ---- workflows ----
  const refreshWorkflows = () => getJson('/api/workflows').then((j) => setWorkflows(j.workflows || [])).catch(() => {});
  useEffect(() => {
    if (!authReady) return;
    refreshWorkflows();
    const t = setInterval(refreshWorkflows, 30_000);
    return () => clearInterval(t);
  }, [authReady]);

  async function addWorkflow() {
    const f = wfForm;
    if (!f.name || !f.classes) return;
    const classes = f.classes.split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      name: f.name,
      region,
      trigger: {
        classes,
        minScore: Number(f.minScore) || 0.4,
        withinMs: (Number(f.withinMin) || 5) * 60_000,
        minDetections: Math.max(1, Number(f.minDetections) || 1),
      },
      actions: [
        { type: 'alert', priority: 'high' },
        ...(f.webhook.trim() ? [{ type: 'webhook', url: f.webhook.trim() }] : []),
      ],
      cooldownMs: 10 * 60_000,
    };
    await fetch('/api/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    setWfForm({ name: '', classes: 'person, bicycle, car', minScore: '0.5', withinMin: '5', minDetections: '1', webhook: '' });
    refreshWorkflows();
  }
  async function toggleWorkflow(id, enabled) {
    await fetch('/api/workflows', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, enabled }) });
    refreshWorkflows();
  }
  async function removeWorkflow(id) {
    await fetch(`/api/workflows?id=${id}`, { method: 'DELETE' });
    refreshWorkflows();
  }

  // Rules + actions (audit log).
  const refreshRules = () => fetch('/api/rules').then((r) => r.json()).then((j) => setRules(j.rules || [])).catch(() => {});
  const refreshActions = () => fetch(`/api/actions?region=${region}`).then((r) => r.json()).then((j) => setActions(j.actions || [])).catch(() => {});
  useEffect(() => { if (authReady) refreshRules(); }, [authReady]);
  useEffect(() => { if (authReady) refreshActions(); }, [region, authReady]);

  // Write-back: record an operational action against the selected entity.
  async function doAction(type) {
    if (!selection) return;
    const body = {
      type, region,
      entityType: selection.layer.label,
      entityLabel: selection.properties.title || selection.layer.label,
      coord: selection.coord || null,
    };
    await fetch('/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    refreshActions();
  }

  async function addRule() {
    const f = ruleForm;
    if (!f.name || !f.layer || !f.field) return;
    const value = f.op === 'in' ? f.value.split(',').map((s) => s.trim()) : f.value;
    await fetch('/api/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, value }) });
    setRuleForm({ name: '', layer: '', field: '', op: 'gte', value: '' });
    refreshRules();
  }
  async function removeRule(id) { await fetch(`/api/rules?id=${id}`, { method: 'DELETE' }); refreshRules(); }

  const activeLayers = ctx.layers || [];
  const activeDefs = useMemo(() => LAYERS.filter((l) => activeLayers.includes(l.id)), [activeLayers]);
  const enabledSet = useMemo(() => new Set(enabled), [enabled]);
  const arc = ctx.arc || [];

  function toggle(id) {
    setEnabled((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function gotoArc(i) {
    setArcIdx(i);
    const step = arc[i];
    if (!step) return;
    setEnabled(step.layers === 'all' ? activeLayers : step.layers);

    const t = step.target || {};
    let center = ctx.center;
    if (t.center) center = t.center;
    else if (t.siteId) center = (ctx.sites.find((s) => s.id === t.siteId) || {}).coord || ctx.center;
    setCommand({ seq: ++seqRef.current, center, zoom: t.zoom ?? ctx.zoom, pitch: 0 });
  }

  // Contacts drawn from a live upstream, and contacts drawn from something else,
  // counted apart. The footer used to call the whole total "live contacts" while
  // the header was flagging some of those same layers as not live. One number
  // per claim, and the claims have to be the same ones the chips make — the same
  // fields, applied the same way, which is why the rule lives in
  // lib/feed-health.js rather than inline here where nothing can test it.
  //
  // What was inline here read `b.notice ? 0 : b.count || 0`, which moved a
  // layer's whole contact count into the not-live column the moment the layer
  // had anything to say about itself. The `cls` expression behind the header
  // chips never reads `notice` — the comment above it says outright that having
  // a notice is not the same as not being live — so the two disagreed in the
  // most misleading direction available: green chip, contacts filed as not live.
  //
  // The same disagreement then survived one field along: the shared rule still
  // counted a feed-level `error` as not-live, so one failed adsb.fi poll over a
  // warm cache filed all 120 aircraft as degraded while the summary below called
  // that feed live and no banner appeared. It no longer does. The error is still
  // visible on the chip and in its tooltip, which is where an error belongs.
  const { liveContacts, degradedContacts } = splitContactCounts(status);
  const wsList = Object.keys(workspaces);

  // Per-feed liveness for the phone header. Same function the footer split above
  // calls, so the one-line summary and the contact counters cannot disagree
  // about a feed — they used to, and this is the sixth time that shape of defect
  // has been fixed. The rule that was inline here said `down` when a feed
  // carried an error and had contacts; the rule in the footer said the same
  // thing about the contacts themselves; the NOT LIVE banner said neither, and
  // the comment three lines up claimed all of them agreed. One implementation,
  // in lib/feed-health.js, where a test can reach it.
  const feedStates = activeDefs.map((l) => feedLiveness(status[l.id]));
  const liveFeedCount = feedStates.filter((s) => s === 'live').length;
  const downFeedCount = feedStates.filter((s) => s === 'down').length;

  // On a phone the detail panel is a closed sheet, so a tap on a map contact
  // would otherwise look like it did nothing. Setting this on a desktop width is
  // inert — see the note on mobileSheet.
  useEffect(() => { if (selection) setMobileSheet('detail'); }, [selection]);

  // ---- human annotations + workspaces (personal, localStorage) ----
  function onAddAnnotation([lng, lat]) {
    const label = window.prompt('Annotation label:');
    if (label === null) return;
    const note = window.prompt('Note (optional):') || '';
    setAnnotations((a) => [...a, { id: `${Date.now()}-${a.length}`, lng, lat, label: label || 'Marker', note }]);
  }
  function removeAnnotation(id) { setAnnotations((a) => a.filter((x) => x.id !== id)); }

  function persistWorkspaces(next) {
    setWorkspaces(next);
    try { localStorage.setItem('parallax.workspaces', JSON.stringify(next)); } catch { /* ignore */ }
  }

  // Apply a workspace's saved view (used by both local and server loads).
  function applyWorkspaceData(ws) {
    if (!ws) return;
    setAnnotateMode(false);
    if (ws.region === region) {
      setEnabled(ws.enabled || activeLayers);
      setAnnotations(ws.annotations || []);
      setCommand({ seq: ++seqRef.current, center: ws.camera?.center || ctx.center, zoom: ws.camera?.zoom ?? ctx.zoom, pitch: 0 });
    } else {
      pendingWsRef.current = ws; // applied when the new region's context loads
      setRegion(ws.region);
    }
  }

  function snapshotWorkspace() { return { region, enabled, annotations, camera: cameraRef.current }; }

  async function saveWorkspace() {
    const name = wsName.trim();
    if (!name) return;
    if (user) {
      const sharedWith = wsAllocate.split(',').map((s) => s.trim()).filter(Boolean);
      await fetch('/api/workspaces', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, data: snapshotWorkspace(), visibility: wsShared ? 'shared' : 'private', classification: wsClass, sharedWith }),
      });
      setWsName(''); setWsAllocate(''); refreshWorkspaces();
    } else {
      persistWorkspaces({ ...workspaces, [name]: snapshotWorkspace() });
      setWsName('');
    }
  }
  function loadWorkspace(name) { applyWorkspaceData(workspaces[name]); }      // local
  function deleteWorkspace(name) { const next = { ...workspaces }; delete next[name]; persistWorkspaces(next); }

  async function loadServerWorkspace(id) {
    const res = await fetch(`/api/workspaces/${id}`);
    if (res.ok) applyWorkspaceData((await res.json()).data);
  }
  async function deleteServerWorkspace(id) { await fetch(`/api/workspaces/${id}`, { method: 'DELETE' }); refreshWorkspaces(); }

  // ---- auth + shared workspaces (server) ----
  // Returns whether a session is present, so the caller can decide whether to
  // fall back to trial access.
  async function refreshWorkspaces() {
    try {
      const j = await (await fetch('/api/workspaces')).json();
      setUser(j.user); setServerWs(j.workspaces || []);
      // Derive trial state from who is signed in, not from having just signed
      // in. Deriving it from the sign-in action meant the badge disappeared on
      // every subsequent page load, because the cookie was already there and
      // the guest route was never called again.
      setTrialSession(j.user?.username === TRIAL_USERNAME && j.user?.role === 'viewer');
      if (j.user?.role === 'admin') {
        fetch('/api/audit').then((r) => r.json()).then((a) => setAuditLog(a.audit || [])).catch(() => {});
        fetch('/api/users').then((r) => r.json()).then((u) => setUsersList(u.users || [])).catch(() => {});
      } else { setAuditLog([]); setUsersList([]); }
      return !!j.user;
    } catch { return false; }
  }
  // Every read route requires a session now, so an anonymous visitor would
  // otherwise land on an empty map. Where trial access is enabled, take a
  // read-only viewer session automatically; the visitor never sees a login
  // wall for a public demonstrator. Where it is not enabled, the sign-in panel
  // is already in the sidebar and nothing changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const signedIn = await refreshWorkspaces();
      if (cancelled) return;
      if (signedIn) { setAuthReady(true); return; }
      const res = await fetch('/api/auth/guest', { method: 'POST' }).catch(() => null);
      // 404 means the deployment has no trial access. That is the private
      // configuration and the sign-in panel handles it.
      if (!cancelled && res?.ok) await refreshWorkspaces();
      // Released whether we ended up signed in, on a trial session, or
      // anonymous. Anonymous still releases: the sign-in panel needs the page
      // functioning, and the guarded calls will simply 401 until they sign in.
      if (!cancelled) setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  async function setUserRole(id, role, clearance) {
    await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, role, clearance }) });
    refreshWorkspaces();
  }
  const canAct = user && (user.role === 'operator' || user.role === 'admin');

  async function doAuth(path) {
    setAuthErr('');
    const res = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: authUser, password: authPass }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setAuthErr(j.error || 'failed'); return; }
    setAuthUser(''); setAuthPass(''); refreshWorkspaces();
  }
  async function signOut() { await fetch('/api/auth/logout', { method: 'POST' }); setUser(null); setServerWs([]); setTrialSession(false); }

  // ---- time replay ----
  //
  // The archive holds 48 hours. The browser cannot, so this loads the window
  // being shown and reloads when the window moves. Sydney transport alone is
  // 300 KB a frame; two days of every layer at once would be hundreds of
  // megabytes into a tab.
  async function loadWindow(fromMs, toMs) {
    let stepMs = 60_000;
    let extent = null;

    const entries = await Promise.all(activeLayers.map(async (id) => {
      try {
        const j = await (await fetch(
          `/api/history/${id}?region=${region}&from=${fromMs}&to=${toMs}`
        )).json();
        if (j.step_ms) stepMs = j.step_ms;
        // The widest extent any active layer reports is how far back the scrub
        // can reach. Taken from the archive rather than from the frames in
        // hand, which only describe the window currently loaded.
        if (j.archive?.from != null) {
          extent = extent
            ? { from: Math.min(extent.from, j.archive.from), to: Math.max(extent.to, j.archive.to) }
            : { from: j.archive.from, to: j.archive.to };
        }
        return [id, j.frames || []];
      } catch { return [id, []]; }
    }));

    // A uniform time axis rather than the union of every layer's raw frame
    // timestamps. The union is ragged — one step five seconds, the next five
    // minutes — so the scrub advanced through wall-clock at a wildly variable
    // rate, and any layer whose history was shorter than the widest one simply
    // had nothing to draw over most of the travel.
    const stamps = entries.flatMap(([, frames]) => frames.map((f) => f.t));
    const ts = [];
    if (stamps.length) {
      // The axis spans the window that was ASKED for, clipped to what actually
      // exists. Deriving it from the frames alone would silently shrink the bar
      // to whatever happened to be recorded, so a gap in the middle of the
      // night would read as though those hours never existed.
      const start = Math.max(fromMs, Math.min(...stamps));
      const end = Math.min(toMs, Math.max(Math.max(...stamps), start));
      for (let t = start; t < end; t += stepMs) ts.push(t);
      ts.push(end);
    }

    return { framesByLayer: Object.fromEntries(entries), timeline: ts, extent };
  }

  async function enterReplay() {
    const to = Date.now();
    const from = to - replaySpanMs;
    const { framesByLayer: fbl, timeline: ts, extent } = await loadWindow(from, to);
    setFramesByLayer(fbl);
    setTimeline(ts);
    setArchiveExtent(extent);
    setReplayWindow({ from, to });
    setFrameIdx(Math.max(0, ts.length - 1));
    setPlaying(false);
    setReplay(true);
  }

  // Changing the span, or stepping the window back a page, reloads from the
  // archive. Held in an effect rather than done inline at every button so there
  // is one path that fetches and one place where a stale window can be caught.
  useEffect(() => {
    if (!replay || !replayWindow) return;
    let cancelled = false;
    setWindowLoading(true);
    loadWindow(replayWindow.from, replayWindow.to)
      .then(({ framesByLayer: fbl, timeline: ts, extent }) => {
        if (cancelled) return;
        setFramesByLayer(fbl);
        setTimeline(ts);
        setArchiveExtent(extent);
        setFrameIdx(Math.max(0, ts.length - 1));
      })
      .finally(() => { if (!cancelled) setWindowLoading(false); });
    return () => { cancelled = true; };
    // activeLayers is deliberately excluded: toggling a layer mid-replay should
    // not silently refetch and jump the playhead back to the end of the window.
  }, [replay, replayWindow, region]);

  useEffect(() => {
    if (!replay || !playing || timeline.length === 0) return;
    // 200ms a step. At the store's 30s cadence that plays the full two-hour
    // window in about 48 seconds; the old 900ms would have taken 3.6 minutes
    // to cross the same window and read as a stall rather than as playback.
    const t = setInterval(() => setFrameIdx((i) => (i + 1 >= timeline.length ? 0 : i + 1)), 200);
    return () => clearInterval(t);
  }, [replay, playing, timeline.length]);

  // Paging moves the window by a whole span, clamped to what the archive holds
  // at the old end and to now at the new end.
  function pageWindow(direction) {
    if (!replayWindow) return;
    const shift = direction * replaySpanMs;
    let from = replayWindow.from + shift;
    let to = replayWindow.to + shift;
    const now = Date.now();
    if (to > now) { to = now; from = now - replaySpanMs; }
    if (archiveExtent && from < archiveExtent.from) {
      from = archiveExtent.from;
      to = Math.min(now, from + replaySpanMs);
    }
    setReplayWindow({ from, to });
  }

  const archivedSpanMs = archiveExtent ? archiveExtent.to - archiveExtent.from : 0;
  // 10% slack so a window that is essentially full does not get a footnote
  // about the last few seconds of it.
  const archiveShortOfSpan = archivedSpanMs > 0 && archivedSpanMs < replaySpanMs * 0.9;

  const canPageBack = !!(replayWindow && archiveExtent && replayWindow.from > archiveExtent.from);
  const canPageForward = !!(replayWindow && replayWindow.to < Date.now() - 60_000);

  // For the selected instant, each layer shows its nearest-past recorded frame.
  const replayFrames = useMemo(() => {
    if (!replay || timeline.length === 0) return {};
    const T = timeline[Math.min(frameIdx, timeline.length - 1)];
    const out = {};
    for (const id of activeLayers) {
      let pick = null;
      for (const f of framesByLayer[id] || []) { if (f.t <= T) pick = f; else break; }
      out[id] = pick?.fc || { type: 'FeatureCollection', features: [] };
    }
    return out;
  }, [replay, frameIdx, timeline, framesByLayer, activeLayers]);

  return (
    <>
      <MapView
        enabled={enabled} command={command} onSelect={setSelection} onStatus={setStatus}
        ontology={ontology} showLinks={showLinks} region={region} activeLayers={activeLayers} sites={ctx.sites}
        replay={replay} replayFrames={replayFrames}
        annotations={annotations} annotateMode={annotateMode} onAddAnnotation={onAddAnnotation}
        onCamera={(c) => { cameraRef.current = c; }} alerts={alerts}
        detections={detections} basemap={basemap} onBasemapChange={setBasemap}
      />

      {graphOpen ? (
        <KnowledgePanel
          region={region}
          onClose={() => setGraphOpen(false)}
          onPick={(n) => setCommand({ seq: ++seqRef.current, center: n.coord, zoom: region === 'world' ? 5 : 12 })}
        />
      ) : (
        <MiniGraph
          region={region}
          onExpand={() => setGraphOpen(true)}
          onPick={(n) => setCommand({ seq: ++seqRef.current, center: n.coord, zoom: region === 'world' ? 5 : 12 })}
        />
      )}

      {/* classification banner */}
      {user && (
        <div className="class-banner" style={{ background: CLASS_COLOR[user.clearance], color: user.clearance >= 2 ? '#1a0505' : '#04121a' }}>
          {CLASSES[user.clearance]}
        </div>
      )}

      {/* Cold-landing city chooser. Sits over the already-moving picture so the
          trial still opens instantly. */}
      {chooserOpen && (
        <div className="chooser-overlay" data-testid="trial-chooser">
          <div className="chooser-card">
            <div className="chooser-head">
              <h2>Where are you?</h2>
              <button className="chooser-close" onClick={() => setChooserOpen(false)} aria-label="Close">×</button>
            </div>
            <p className="chooser-lede">Open the trial on a region. All eighty-three run from the one deployment.</p>
            <input
              className="chooser-search"
              type="search"
              placeholder="Search regions…"
              value={chooserSearch}
              onChange={(e) => setChooserSearch(e.target.value)}
            />
            <div className="chooser-featured">
              {FEATURED_REGION_IDS.map((id) => (
                <button key={id} className="chooser-tile" onClick={() => chooseRegion(id)}>
                  {FEATURED_REGION_LABELS[id]}
                </button>
              ))}
            </div>
            <div className="chooser-groups">
              {groupRegionsByTheatre(regions)
                .map(({ theatre, regions: inTheatre }) => ({
                  theatre,
                  regions: inTheatre.filter((r) =>
                    !chooserSearch || r.name.toLowerCase().includes(chooserSearch.toLowerCase())),
                }))
                .filter((g) => g.regions.length > 0)
                .map(({ theatre, regions: inTheatre }) => (
                  <div key={theatre} className="chooser-group">
                    <h3>{theatre}</h3>
                    {inTheatre.map((r) => (
                      <button key={r.id} className="chooser-item" onClick={() => chooseRegion(r.id)}>
                        {regionOptionLabel(r)}
                      </button>
                    ))}
                  </div>
                ))}
            </div>
            <button className="chooser-enter" onClick={() => setChooserOpen(false)}>Enter Sydney</button>
          </div>
        </div>
      )}

      {/* header */}
      <header id="topbar">
        <div className="brand">
          <span className="mark">◈</span>
          <div>
            <div className="title">BLUEBIRD PHILOTAS</div>
            <div className="subtitle">Common Operating Picture — {ctx.name}</div>
          </div>
        </div>
        {/* Grouped by theatre, not by type. At 83 entries a flat list is
            unusable, and the previous four hard-coded type groups dropped every
            `type: 'strait'` region silently — see lib/region-groups.js. This
            stays a native <select> deliberately: on a phone the OS renders the
            open list, so 83 options across seven optgroups scroll natively and
            the bottom sheet is not involved. */}
        <select className="region-select" value={region} onChange={(e) => setRegion(e.target.value)}>
          {groupRegionsByTheatre(regions).map(({ theatre, regions: inTheatre }) => (
            <optgroup key={theatre} label={theatre}>
              {inTheatre.map((r) => <option key={r.id} value={r.id}>{regionOptionLabel(r)}</option>)}
            </optgroup>
          ))}
        </select>
        <div className="search-wrap">
          <input className="search-input" placeholder="🔍 search entities…" value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)} />
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((r, i) => (
                <div key={i} className="sr">
                  <div className="sr-head" onClick={() => flyToResult(r)}>
                    <span className="swatch" style={{ background: r.color }} />
                    <span className="sr-title">{r.title}</span>
                    <span className="sr-layer">{r.layer}</span>
                  </div>
                  {r.connections?.length > 0 && (
                    <div className="sr-conns">
                      {r.connections.slice(0, 5).map((c, j) => (
                        <button key={j} className="sr-conn" title={`${c.type} · confidence ${c.confidence}`} onClick={() => setSearchQ(c.other)}>
                          {c.type} → {c.other}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="health">
          {activeDefs.map((l) => {
            const st = status[l.id] || {};
            const hasData = (st.count || 0) > 0;
            // Hard error (no data) → red. Error/stale but still serving data → amber.
            // Degraded (serving something other than live upstream) → amber too,
            // and never green: a layer must not look healthy while showing data
            // that is not live.
            //
            // "Degraded" is whatever the feed itself says is degraded. Every such
            // feed sets `notice` — camera sites with no imagery, hotspots with no
            // FIRMS key, an empty vessel layer — and the banner further down reads
            // the same field, so the header chip and the banner cannot disagree.
            //
            // This previously read `st.source !== 'ais'`, written when AIS was the
            // only vessel source. Dropping AIS left every layer permanently
            // flagged: a live TfNSW feed reporting 'tfnsw+portauthority' is not
            // 'ais', so the header marked everything ⚠ while the footer counted
            // the very same contacts as live.
            // Not live means the DATA is not current, which the cache decides
            // from when the feed was last known good. Having a notice is not
            // the same thing — the satellite layer notes that its primary
            // source is unreachable while serving live positions from the
            // fallback.
            //
            // Nor is answering from the archive the same thing, which is what
            // this line used to say. Ten seconds after every restart all twelve
            // layers answer from the archive while their pollers are in flight,
            // and marking those ⚠ is the same defect as the `st.source !== 'ais'`
            // line above it, one rule further on: a header that contradicts the
            // footer counting the very same contacts.
            const notLive = st.live === false;
            const cls = st.error && !hasData ? 'err'
              : (st.error || st.stale || notLive) ? 'stale'
              : st.count != null ? 'ok' : '';
            return (
              <span key={l.id} className={`chip ${cls}`} title={st.notice || st.error || ''}>
                <span className="dot" />{l.label.split(' ')[0]} {st.error && !hasData ? '!' : st.count ?? '·'}
                {notLive ? ' ⚠' : ''}
              </span>
            );
          })}
        </div>
        {/* Phone stand-in for the twelve chips, which do not fit a phone header.
            It makes the same claim they do and opens the FEEDS sheet, where each
            feed's notice is readable text rather than a title tooltip no touch
            device can reach. Hidden above the phone breakpoint. */}
        <button
          className={`mobile-feed-pill ${downFeedCount ? 'degraded'
            : liveFeedCount < activeDefs.length ? 'pending' : ''}`}
          onClick={() => setMobileSheet((s) => (s === 'feeds' ? null : 'feeds'))}
          title="Per-feed status"
        >
          <span className="dot" />
          {activeDefs.length ? `${liveFeedCount}/${activeDefs.length} live` : 'feeds'}
        </button>
        <button className="proj-toggle" onClick={() => setGraphOpen(true)} title="Knowledge graph">◉ Graph</button>
        <div className={`alert-badge ${alerts.length ? 'live' : ''}`} title="Active alerts">🔔 {alerts.length}</div>
        <div className="clock"><span>{clock}</span> AEST</div>
      </header>

      {/* Case files. Recorded, and labelled as recorded — replaying a past
          moment while implying it is live would be exactly the thing this
          product claims not to do. */}
      {caseFiles.length > 0 && (
        <aside id="casefiles" className={`panel ${mobileSheet === 'cases' ? 'mobile-open' : ''}`}>
          <div className="panel-head">
            CASE FILES <span className="cf-count">{caseFiles.length}</span>
            <span className="cf-recorded">recorded</span>
          </div>
          <div className="cf-list">
            {caseFiles.map((f) => (
              <button
                key={f.id}
                className={`cf-item ${openCase?.id === f.id ? 'on' : ''}`}
                onClick={() => openCaseFile(f)}
                title={f.replayable_layers?.length ? `Replay ${f.replayable_layers.length} recorded layers` : 'No recorded frames yet'}
              >
                <div className="cf-title">{f.title}</div>
                <div className="cf-when">
                  {new Date(f.at_ms).toLocaleString()}
                  {!f.replayable_layers?.length && <span className="cf-noframes"> · no frames yet</span>}
                </div>
                <div className="cf-assess">{f.assessment}</div>
                <div className="cf-meta">
                  <span className={`cf-method ${f.assessment_method}`}>{f.assessment_method}</span>
                  <span className="cf-evidence">{f.evidence}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>
      )}

      {selection && (intelLoading || intel) && (
        <aside id="intel" className={`panel ${mobileSheet === 'intel' ? 'mobile-open' : ''}`}>
          <div className="panel-head">
            OPEN SOURCE
            {intel?.documents?.length ? <span className="cf-count">{intel.documents.length}</span> : null}
          </div>

          {intelLoading && <div className="intel-empty">searching open sources…</div>}
          {!intelLoading && intel?.notice && <div className="intel-empty">{intel.notice}</div>}

          {!!intel?.documents?.length && (
            <div className="intel-block">
              <div className="intel-h">Documents</div>
              {intel.documents.slice(0, 6).map((d) => (
                <a key={d.id} className="intel-doc" href={d.url} target="_blank" rel="noopener">
                  <span className="intel-doc-title">{d.title}</span>
                  <span className="intel-doc-src">{d.source}{d.published_ms ? ` · ${new Date(d.published_ms).toLocaleDateString()}` : ''}</span>
                </a>
              ))}
            </div>
          )}

          {!!intel?.connections?.length && (
            <div className="intel-block">
              <div className="intel-h">Connected entities</div>
              {intel.connections.slice(0, 8).map((c) => (
                <div key={c.entity_key} className="intel-conn">
                  <span className="intel-conn-label">{c.entity_label}</span>
                  <span className="intel-conn-n">{c.shared_documents} shared</span>
                </div>
              ))}
              <div className="intel-note">Co-mention in the same documents. Not a resolved relationship.</div>
            </div>
          )}

          {!!intel?.hypotheses?.length && (
            <div className="intel-block hyp">
              <div className="intel-h">Hypotheses <span className="hyp-tag">unverified</span></div>
              {intel.hypotheses.map((h) => (
                <div key={h.id} className="intel-hyp">
                  <div className="intel-hyp-statement">{h.statement}</div>
                  <div className="intel-hyp-test"><b>Confirm by</b> {h.confirms_if}</div>
                  <div className="intel-hyp-test"><b>Refuted by</b> {h.refutes_if}</div>
                </div>
              ))}
            </div>
          )}
        </aside>
      )}

      {/* The status lines that sit under the header. Grouped only so the phone
          layout can stack them in a column: `.page-notices` is `display: contents`
          above the breakpoint, so it generates no box and the desktop positions
          of everything inside it are untouched. */}
      <div className="page-notices">
        {trialSession && (
          <div className="trial-badge">
            READ-ONLY TRIAL · viewer role · write-back, rules and administration disabled
          </div>
        )}

        {/* Anything not served from live upstream says so, in the operator's
            eyeline rather than buried in a tooltip. */}
        {/* In replay the whole picture is recorded on purpose, so say WHICH
            moment is on screen and how far the window reaches. Per-layer
            liveness notices are suppressed here: they describe live fetching,
            which is not what the operator is looking at. */}
        {replay && timeline.length > 0 && (
          <div className="data-notice replaying">
            <strong>Replay</strong> · {formatSpan(replaySpanMs)} sliding window ·{' '}
            {formatWindow(timeline[0], timeline[timeline.length - 1])}
            <span className="muted">
              {' '}· showing {new Date(timeline[Math.min(frameIdx, timeline.length - 1)])
                .toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
              {/* Selecting 48 hours on a service that has been recording for
                  forty minutes must not imply two days exist. The window is a
                  retention policy; the archive is what has actually been kept,
                  and only the second one is a claim about data. */}
              {archiveShortOfSpan ? ` · ${formatSpan(archivedSpanMs)} recorded so far` : ''}
            </span>
          </div>
        )}

        {/* Live mode. Only layers whose DATA is not current, which is not the
            same set as layers with something to say — a feed running on its
            fallback source is live and must not be flagged as though it were
            not. Informational notices stay in the layer panel.

            Where the bytes came from and whether they are current are two
            different facts, and this banner used to conflate them: any layer
            answering from the archive was labelled NOT LIVE and told the
            operator "upstream has not answered since". Measured on the trial
            2026-08-16, that sentence was false for ten seconds after every
            restart — all twelve layers answer from the archive at t+3s while
            their pollers are mid-flight, and the upstream had not failed to
            answer, it had not yet been asked. Liveness is `st.live`, which the
            cache decides from when the feed was last known good. Provenance is
            `from_archive_ms`, which still says how old the data on screen is,
            because that must never stop being true. */}
        {!replay && Object.entries(status)
          .filter(([, st]) => st.live === false)
          .map(([id, st]) => (
            <div key={id} className="data-notice">
              <strong>Not live</strong> ·{' '}
              {st.from_archive_ms
                ? `${FEED_LABEL[id] || id} recorded ${formatAgo(st.from_archive_ms)} — upstream has not answered since`
                : st.notice || `${FEED_LABEL[id] || id} is not serving current data`}
            </div>
          ))}

        {/* Current, but not from this minute's call. Says what it is without
            claiming a fault, so an operator can tell "recorded, refreshing" from
            "nobody is answering".

            ONE line, not one per layer. Every .data-notice is absolutely
            positioned at the same offset, so a list of them renders as a single
            illegible stack — which is what the not-live list above has always
            done, unnoticed because it rarely had more than one entry. Straight
            after a restart this state applies to every layer at once, so it has
            to summarise. Oldest age is quoted because that is the honest bound on
            what is on screen. */}
        {!replay && (() => {
          const recorded = Object.entries(status)
            .filter(([, st]) => st.live !== false && st.from_archive_ms);
          if (recorded.length === 0) return null;
          const oldest = Math.min(...recorded.map(([, st]) => st.from_archive_ms));
          const what = recorded.length === 1
            ? FEED_LABEL[recorded[0][0]] || recorded[0][0]
            : `${recorded.length} layers`;
          return (
            <div className="data-notice recorded">
              <strong>Recorded</strong> ·{' '}
              {`${what} from ${formatAgo(oldest)}, refreshing now`}
            </div>
          );
        })()}
      </div>

      {/* Phone only — hidden above the breakpoint, where the twelve header chips
          carry this. Rows rather than chips because a phone has the width for
          them, and because a chip's state lives in a title tooltip that a touch
          device cannot open: a notice nobody can read is a notice that was
          dropped. */}
      <aside id="feeds" className={`panel ${mobileSheet === 'feeds' ? 'mobile-open' : ''}`}>
        <div className="panel-head">FEEDS</div>
        {activeDefs.map((l, i) => {
          const st = status[l.id] || {};
          const state = feedStates[i];
          return (
            <div key={l.id} className={`feed-row ${state}`}>
              <span className="feed-dot" />
              <span className="feed-name">{l.label}</span>
              <span className="feed-count">{st.error && !(st.count > 0) ? 'err' : (st.count ?? '·')}</span>
              <span className="feed-state">{state === 'down' ? 'not live' : state}</span>
              {(st.notice || st.error) && <div className="feed-notice">{st.notice || st.error}</div>}
            </div>
          );
        })}
      </aside>

      {/* layers */}
      <aside id="layers" className={`panel ${mobileSheet === 'layers' ? 'mobile-open' : ''}`}>
        {/* ---- capabilities: what the system can do, one tap each ---- */}
        <div className="caps">
          <div className="panel-head">CAPABILITIES</div>

          <div className="cap-tile">
            <span className="cap-ico">🗺</span>
            <div className="cap-body">
              <div className="cap-name">Google basemaps · satellite</div>
              <div className="cap-line">Roadmap, dark, satellite, hybrid, terrain</div>
              <div className="cap-btns">
                {[['dark', 'Dark'], ['roadmap', 'Map'], ['satellite', '🛰 Sat'], ['hybrid', '🛰+'], ['terrain', '⛰']].map(([id, label]) => (
                  <button key={id} className={'cap-btn' + (basemap === id ? ' on' : '')} onClick={() => setBasemap(id)}>{label}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="cap-tile">
            <span className="cap-ico">🔍</span>
            <div className="cap-body">
              <div className="cap-name">Object detection</div>
              <div className="cap-line">Cameras, video feeds and uploads; find other instances of any object</div>
              <div className="cap-btns">
                <button className="btn cap-btn" disabled={visionBusy || !canAct} onClick={scanCameras} title={canAct ? 'Run the detector over every live camera in this region' : 'Detection is operator-only — sign in below'}>
                  {canAct ? 'Scan region cameras' : 'sign in to scan'}
                </button>
                <button className="btn cap-btn" onClick={() => document.getElementById('vision-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>Open VISION panel</button>
              </div>
            </div>
          </div>

          <div className="cap-tile">
            <span className="cap-ico">⚙</span>
            <div className="cap-body">
              <div className="cap-name">Detection workflows</div>
              <div className="cap-line">Detections raise alerts and run actions — e.g. an accident at a traffic light</div>
              <div className="cap-btns">
                <button className="btn cap-btn" onClick={() => document.getElementById('workflows-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })}>Open WORKFLOWS</button>
                {alerts.length > 0 && (
                  <button className="btn cap-btn" onClick={() => { const a = alerts.find((x) => x.coord); if (a) setCommand({ seq: ++seqRef.current, center: a.coord, zoom: 14 }); }}>
                    ⚑ View alert
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="cap-tile">
            <span className="cap-ico">◉</span>
            <div className="cap-body">
              <div className="cap-name">AI knowledge graph</div>
              <div className="cap-line">Entities and their resolved links, with news and provenance</div>
              <div className="cap-btns">
                <button className="btn cap-btn" onClick={() => setGraphOpen(true)}>Open graph</button>
              </div>
            </div>
          </div>

          <div className="cap-tile">
            <span className="cap-ico">⏱</span>
            <div className="cap-body">
              <div className="cap-name">Time replay</div>
              <div className="cap-line">Scrub 48 hours of recorded frames</div>
              <div className="cap-btns">
                <button className="btn cap-btn" onClick={enterReplay} disabled={replay}>{replay ? 'replaying…' : 'Replay last hour'}</button>
              </div>
            </div>
          </div>
        </div>

        <div className="panel-head">LAYERS</div>
        {activeDefs.map((l) => {
          const st = status[l.id] || {};
          const off = !enabledSet.has(l.id);
          const hasData = (st.count || 0) > 0;
          const stale = (st.error || st.stale) && hasData;
          return (
            <div key={l.id} className={`layer-row ${off ? 'off' : ''}`} onClick={() => toggle(l.id)} title={st.error || ''}>
              <span className="swatch" style={{ background: l.color }} />
              <span className="name">{l.label}</span>
              <span className={`count ${stale ? 'stale' : ''}`}>{st.error && !hasData ? 'err' : (st.count ?? '·')}</span>
            </div>
          );
        })}
        {ctx.sites.length > 0 && (
          <>
            <div className="panel-head" style={{ marginTop: 14 }}>FIXED SITES</div>
            <div className="sites">
              {ctx.sites.map((s) => (
                <div key={s.id} className="site" onClick={() => setCommand({ seq: ++seqRef.current, center: s.coord, zoom: 12 })}>
                  <span className="pin">⌖</span><span>{s.name}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="panel-head" style={{ marginTop: 14 }}>
          WORKSPACE
          {user ? <span className="ws-who">● {user.username} · {user.role} · <span style={{ color: CLASS_COLOR[user.clearance] }}>{CLASSES[user.clearance]}</span> <button className="ws-link" onClick={signOut}>sign out</button></span>
                : <span className="ws-who muted">local only</span>}
        </div>
        <button className={`btn ws-annotate ${annotateMode ? 'on' : ''}`} onClick={() => setAnnotateMode((m) => !m)}>
          {annotateMode ? '✏ Annotating — click the map' : '✏ Annotate'}
        </button>
        {annotations.length > 0 && (
          <div className="ws-anns">
            {annotations.map((a) => (
              <div key={a.id} className="ws-ann">
                <span title={a.note} onClick={() => setCommand({ seq: ++seqRef.current, center: [a.lng, a.lat], zoom: 10 })}>⚑ {a.label}</span>
                <button onClick={() => removeAnnotation(a.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        {!user && (
          <div className="ws-authform">
            <input placeholder="username" value={authUser} onChange={(e) => setAuthUser(e.target.value)} />
            <input placeholder="password" type="password" value={authPass} onChange={(e) => setAuthPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doAuth('login'); }} />
            <div className="ws-authbtns">
              <button className="btn" onClick={() => doAuth('login')}>Sign in</button>
              <button className="btn" onClick={() => doAuth('register')}>Register</button>
            </div>
            {authErr && <div className="ws-err">{authErr}</div>}
          </div>
        )}

        <div className="ws-save">
          <input placeholder="workspace name" value={wsName} onChange={(e) => setWsName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveWorkspace(); }} />
          <button className="btn" onClick={saveWorkspace}>Save</button>
        </div>
        {user && (
          <>
            <div className="ws-acl">
              <label className="ws-vis"><input type="checkbox" checked={wsShared} onChange={(e) => setWsShared(e.target.checked)} /> whole team</label>
              <select value={wsClass} onChange={(e) => setWsClass(Number(e.target.value))} title="Classification">
                {CLASSES.slice(0, (user.clearance ?? 0) + 1).map((c, i) => <option key={i} value={i}>{c}</option>)}
              </select>
            </div>
            <input className="ws-allocate" placeholder="allocate to users (comma-separated)" value={wsAllocate} onChange={(e) => setWsAllocate(e.target.value)} />
          </>
        )}

        {user ? (
          serverWs.length > 0 && (
            <div className="ws-list">
              {serverWs.map((w) => (
                <div key={w.id} className="ws-item">
                  <span onClick={() => loadServerWorkspace(w.id)} title={`${w.visibility === 'shared' ? 'team' : 'private'} · ${CLASSES[w.classification]}${w.sharedWith?.length ? ' · ' + w.sharedWith.join(', ') : ''}`}>
                    <span className="ws-cls" style={{ color: CLASS_COLOR[w.classification] }}>{CLASSES[w.classification].slice(0, 1)}</span>
                    {w.visibility === 'shared' ? ' ⬡' : (w.sharedWith?.length ? ' 👥' : ' ▢')} {w.name}{!w.mine && <em> · {w.owner}</em>}
                  </span>
                  {w.mine && <button onClick={() => deleteServerWorkspace(w.id)}>✕</button>}
                </div>
              ))}
            </div>
          )
        ) : (
          wsList.length > 0 && (
            <div className="ws-list">
              {wsList.map((name) => (
                <div key={name} className="ws-item">
                  <span onClick={() => loadWorkspace(name)}>⬡ {name}</span>
                  <button onClick={() => deleteWorkspace(name)}>✕</button>
                </div>
              ))}
            </div>
          )
        )}
      </aside>

      {/* detail / arc */}
      <aside id="detail" className={`panel ${mobileSheet === 'detail' ? 'mobile-open' : ''}`}>
        <div className="panel-head">ALERTS <span className="muted">· {alerts.length} active</span></div>
        {alerts.length === 0 ? (
          <div className="muted" style={{ fontSize: 11 }}>No rule triggered this cycle.</div>
        ) : (
          <div className="alerts-list">
            {alerts.slice(0, 12).map((a, i) => (
              <div key={`${a.id}-${i}`} className="alert-row" onClick={() => a.coord && setCommand({ seq: ++seqRef.current, center: a.coord, zoom: region === 'world' ? 5 : 11 })}>
                <span className="alert-dot" />
                <span className="alert-label">{a.label}</span>
                {a.workflow && <span className="alert-wf" title="raised by a detection workflow">⚙</span>}
                {a.demo && <span className="demo-tag" title="seeded example — npm run demo:seed regenerates it">example</span>}
                <span className="alert-meta">{a.workflow ? a.rule : `${a.field} ${String(a.value)}`}</span>
              </div>
            ))}
          </div>
        )}

        <div className="panel-head" style={{ marginTop: 14 }}>
          RESOLVED CONNECTIONS
          <span className={`ont-badge ${ontology?.method === 'llm' ? 'llm' : ''}`}>
            {ontology ? (ontology.method === 'llm' ? 'LLM' : 'heuristic') : '…'}
          </span>
        </div>
        {!ontology ? (
          <div className="muted">Resolving…</div>
        ) : (
          <div className="ontology">
            <div className="ont-stats">
              <span>{ontology.stats.entities} entities</span>
              <span>{ontology.stats.links} links</span>
              <label className="ont-toggle">
                <input type="checkbox" checked={showLinks} onChange={(e) => setShowLinks(e.target.checked)} /> draw on map
              </label>
            </div>
            {annotations.length > 0 && (
              <div className="ont-human">+ {annotations.length} human augmentation{annotations.length > 1 ? 's' : ''} · method <b>human</b></div>
            )}
            {ontology.method !== 'llm' && (
              <div className="muted ont-note">
                {ontology.llmConfigured ? 'Heuristic resolver — the model was unreachable this cycle.' : 'Heuristic resolver. Set ONTOLOGY_LLM to enable model adjudication.'}
              </div>
            )}
            <div className="ont-links">
              {ontology.links.slice(0, 7).map((l) => (
                <div className="ont-link" key={l.id} title={l.provenance}>
                  <div className="ont-link-top">
                    <span className="ont-from">{l.fromLabel}</span>
                    <span className="ont-rel">{l.type}</span>
                    <span className="ont-to">{l.toLabel}</span>
                    <span className="ont-conf" style={{ color: l.confidence >= 0.7 ? 'var(--ok)' : 'var(--warn)' }}>{l.confidence}</span>
                  </div>
                  <div className="ont-why">
                    <span className={`ont-method ${l.method}`}>{l.method}</span> {l.provenance}
                  </div>
                </div>
              ))}
              {ontology.links.length === 0 && <div className="muted">No cross-feed links resolved this cycle.</div>}
            </div>
          </div>
        )}

        {arc.length > 0 && (
          <>
            <div className="panel-head" style={{ marginTop: 14 }}>DEMO ARC <span className="muted">· ~90s</span></div>
            <div className="arc">
              {arc.map((s, i) => (
                <div key={i} className={`step ${i === arcIdx ? 'active' : ''}`} onClick={() => gotoArc(i)}>
                  <div className="s-title">{s.title}</div>
                  <div className="s-body">{s.body}</div>
                </div>
              ))}
              <div className="arc-controls">
                <button className="btn" onClick={() => gotoArc((arcIdx - 1 + arc.length) % arc.length)}>◀ Prev</button>
                <button className="btn" onClick={() => gotoArc((arcIdx + 1) % arc.length)}>Next ▶</button>
              </div>
            </div>
          </>
        )}

        <div className="panel-head" style={{ marginTop: 14 }}>SELECTION</div>
        {!selection ? (
          <div className="selection muted">Click a contact on the map.</div>
        ) : (
          <div className="selection">
            <h4 style={{ color: selection.layer.color }}>{selection.properties.title || selection.layer.label}</h4>
            {selection.rows.map(([k, v], j) => (
              <div className="row" key={j}>
                <span className="k">{k}</span>
                <span className="v" dangerouslySetInnerHTML={{ __html: String(v) }} />
              </div>
            ))}
            {canAct ? (
              <div className="action-btns">
                <button className="btn act" onClick={() => doAction('flag')}>⚑ Flag</button>
                <button className="btn act" onClick={() => doAction('task')}>＋ Task</button>
                <button className="btn act" onClick={() => doAction('dispatch')}>📡 Dispatch</button>
                <button className="btn act" onClick={() => doAction('watch')}>👁 Watch</button>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>Sign in as an operator to act on entities (read-only).</div>
            )}

            {/* Object detection on a camera still: draw the model's boxes over
                the image and offer "find other instances of this" per box. */}
            {selection.layer.id === 'cameras' && selection.properties.image && (
              <div className="vision-cam">
                <div className="vision-img-wrap">
                  <img src={selection.properties.image} alt="" className="vision-img" />
                  {imageDets.map((d, i) => (
                    <div
                      key={i}
                      className="vision-box"
                      style={{
                        left: `${(d.bbox[0] * 100).toFixed(2)}%`, top: `${(d.bbox[1] * 100).toFixed(2)}%`,
                        width: `${((d.bbox[2] - d.bbox[0]) * 100).toFixed(2)}%`,
                        height: `${((d.bbox[3] - d.bbox[1]) * 100).toFixed(2)}%`,
                      }}
                      title={`${d.class} ${Math.round(d.score * 100)}%`}
                    >
                      <span>{d.class} {Math.round(d.score * 100)}%</span>
                    </div>
                  ))}
                </div>
                <div className="vision-actions">
                  <button className="btn" disabled={visionBusy} onClick={detectSelectionImage}>🔍 Detect objects in this image</button>
                </div>
                {imageDets.length > 0 && (
                  <div className="vision-dets">
                    {imageDets.slice(0, 8).map((d, i) => (
                      <div key={i} className="vision-det">
                        <span className="v-class">{d.class}</span>
                        <span className="v-score">{Math.round((d.score || 0) * 100)}%</span>
                        <button className="btn v-sim" onClick={() => findSimilarFor(d)}>find other instances</button>
                      </div>
                    ))}
                  </div>
                )}
                {similar.length > 0 && (
                  <div className="vision-sim">
                    <div className="muted" style={{ fontSize: 10 }}>Similar on other cameras:</div>
                    {similar.map((m, i) => (
                      <div key={i} className="vs-row" onClick={() => m.coord && setCommand({ seq: ++seqRef.current, center: m.coord, zoom: 13 })}>
                        <span className="vs-id">{m.id}</span>
                        <span className="vs-score">{Math.round((m.score || 0) * 100)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---- vision: object detection across cameras and video feeds ---- */}
        <div id="vision-section" className="panel-head" style={{ marginTop: 14 }}>
          VISION <span className="muted">· object detection</span>
          {detHealth && (
            <span className={`det-health ${detHealth.ok ? 'ok' : 'err'}`}>
              {detHealth.ok ? detHealth.engine : 'offline'}
            </span>
          )}
        </div>
        {!detHealth ? (
          <div className="muted">Checking detection service…</div>
        ) : !detHealth.ok ? (
          <div className="vision-note">
            {detHealth.error || 'Detection service unavailable'} — start it per <code>detect/README.md</code>
            (set <code>DETECTION_URL</code> if it is remote).
          </div>
        ) : (
          <div className="vision-note">Model: {detHealth.model || detHealth.engine} · {detHealth.classes || '—'}</div>
        )}
        <div className="vision-actions">
          <button className="btn" disabled={visionBusy} onClick={scanCameras}>📷 Scan region cameras</button>
        </div>
        <div className="vision-video">
          <input placeholder="video feed URL (mp4 / m3u8)…" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
          <input placeholder="anchor lng,lat (optional)" value={videoCoord} onChange={(e) => setVideoCoord(e.target.value)} />
          <div className="vision-video-row">
            <button className="btn" disabled={visionBusy} onClick={scanVideo}>🎞 Scan video feed</button>
            <label className="btn vision-upload">
              ⬆ Upload image
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => uploadImage(e.target.files && e.target.files[0])} />
            </label>
          </div>
        </div>
        {visionMsg && <div className="vision-msg">{visionMsg}</div>}
        <div className="det-list">
          {detections.slice(0, 10).map((d, i) => (
            <div key={d.id || i} className="det-row" onClick={() => d.coord && setCommand({ seq: ++seqRef.current, center: d.coord, zoom: 13 })}>
              <span className="det-class">{d.class}</span>
              <span className="det-score">{Math.round((d.score || 0) * 100)}%</span>
              <span className="det-src">{d.source === 'video' ? '🎞' : d.source === 'upload' ? '⬆' : d.source === 'demo' ? '✨' : '📷'} {d.sourceId || d.source}</span>
              {d.demo && <span className="demo-tag" title="seeded example — npm run demo:seed regenerates it">demo</span>}
              <span className="det-when">{formatAgo(d.detected_at_ms)}</span>
            </div>
          ))}
          {detections.length === 0 && <div className="muted">No detections recorded for this region yet.</div>}
        </div>

        {/* ---- workflows: detections trigger alerts and actions ---- */}
        <div id="workflows-section" className="panel-head" style={{ marginTop: 14 }}>WORKFLOWS <span className="muted">· detection → alert</span></div>
        <div className="wf-list">
          {workflows.map((w) => (
            <div key={w.id} className={`wf-row ${w.enabled === false ? 'off' : ''}`}>
              <label className="wf-toggle" title={w.enabled === false ? 'enable' : 'disable'}>
                <input type="checkbox" checked={w.enabled !== false} onChange={(e) => toggleWorkflow(w.id, e.target.checked)} />
              </label>
              <span className="wf-name" title={w.summary}>{w.name}{w.builtin ? <em> · built-in</em> : null}</span>
              {!w.builtin && <button onClick={() => removeWorkflow(w.id)}>✕</button>}
            </div>
          ))}
          {workflows.length === 0 && <div className="muted">No workflows yet.</div>}
        </div>
        <div className="wf-form">
          <input placeholder="workflow name" value={wfForm.name} onChange={(e) => setWfForm({ ...wfForm, name: e.target.value })} />
          <input placeholder="classes (csv): person, bicycle" value={wfForm.classes} onChange={(e) => setWfForm({ ...wfForm, classes: e.target.value })} />
          <div className="wf-form-row">
            <input type="number" step="0.05" min="0.1" max="1" placeholder="min score" title="minimum confidence" value={wfForm.minScore} onChange={(e) => setWfForm({ ...wfForm, minScore: e.target.value })} />
            <input type="number" min="1" placeholder="window min" title="detection window in minutes" value={wfForm.withinMin} onChange={(e) => setWfForm({ ...wfForm, withinMin: e.target.value })} />
            <input type="number" min="1" placeholder="min count" title="detections required in the window" value={wfForm.minDetections} onChange={(e) => setWfForm({ ...wfForm, minDetections: e.target.value })} />
          </div>
          <input placeholder="webhook URL (optional)" value={wfForm.webhook} onChange={(e) => setWfForm({ ...wfForm, webhook: e.target.value })} />
          <button className="btn" onClick={addWorkflow}>＋ Create workflow</button>
        </div>
        <div className="wf-hint muted">
          Example: <em>accident at a traffic light</em> — classes <em>car, person</em>, min score 0.5,
          ≥ 2 detections within 5 minutes on this region's cameras → alert raised, workflow attached.
        </div>
        {workflows.some((w) => w.lastRun) && (
          <div className="wf-runs">
            {workflows.filter((w) => w.lastRun).slice(0, 4).map((w) => (
              <div key={w.id} className="wf-run" onClick={() => w.lastRun.coord && setCommand({ seq: ++seqRef.current, center: w.lastRun.coord, zoom: 13 })}>
                <span className="wf-run-name">{w.name}</span>
                <span className="wf-run-when">{formatAgo(w.lastRun.firedAt)} · {w.lastRun.count} detections</span>
              </div>
            ))}
          </div>
        )}

        {actions.length > 0 && (
          <>
            <div className="panel-head" style={{ marginTop: 14 }}>ACTIONS <span className="muted">· audit</span></div>
            <div className="action-log">
              {actions.slice(0, 8).map((a) => (
                <div key={a.id} className="action-row" onClick={() => a.coord && setCommand({ seq: ++seqRef.current, center: a.coord, zoom: 11 })}>
                  <span className="action-type">{a.type}</span>
                  <span className="action-label">{a.entityLabel}</span>
                  <span className="action-meta">{a.user} · {new Date(a.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="panel-head" style={{ marginTop: 14 }}>RULES</div>
        <div className="rules-list">
          {rules.map((r) => (
            <div key={r.id} className="rule-row">
              <span className="rule-name">{r.name}</span>
              {!r.builtin && <button onClick={() => removeRule(r.id)}>✕</button>}
            </div>
          ))}
        </div>
        <div className="rule-form">
          <input placeholder="name" value={ruleForm.name} onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} />
          <div className="rule-form-row">
            <select value={ruleForm.layer} onChange={(e) => setRuleForm({ ...ruleForm, layer: e.target.value })}>
              <option value="">layer…</option>
              {activeDefs.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}
            </select>
            <input placeholder="field" value={ruleForm.field} onChange={(e) => setRuleForm({ ...ruleForm, field: e.target.value })} />
          </div>
          <div className="rule-form-row">
            <select value={ruleForm.op} onChange={(e) => setRuleForm({ ...ruleForm, op: e.target.value })}>
              <option value="gte">≥</option><option value="lte">≤</option><option value="eq">=</option>
              <option value="contains">contains</option><option value="in">in (csv)</option>
            </select>
            <input placeholder="value" value={ruleForm.value} onChange={(e) => setRuleForm({ ...ruleForm, value: e.target.value })} />
            <button className="btn" onClick={addRule}>Add</button>
          </div>
        </div>

        {user?.role === 'admin' && (
          <>
            <div className="panel-head" style={{ marginTop: 14 }}>USERS <span className="muted">· admin</span></div>
            <div className="users-list">
              {usersList.map((u) => (
                <div key={u.id} className="user-row">
                  <span className="user-name">{u.username}</span>
                  <select value={u.role} onChange={(e) => setUserRole(u.id, e.target.value, u.clearance ?? 0)}>
                    <option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option>
                  </select>
                  <select value={u.clearance ?? 0} onChange={(e) => setUserRole(u.id, u.role, Number(e.target.value))}>
                    {CLASSES.map((c, i) => <option key={i} value={i}>{c.slice(0, 4)}</option>)}
                  </select>
                </div>
              ))}
            </div>

            <div className="panel-head" style={{ marginTop: 14 }}>AUDIT <span className="muted">· admin</span></div>
            <div className="audit-log">
              {auditLog.slice(0, 12).map((e) => (
                <div key={e.id} className="audit-row">
                  <span className="audit-event">{e.event}</span>
                  <span className="audit-detail">{e.user}: {e.detail}</span>
                  <span className="audit-ts">{new Date(e.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </aside>

      {/* replay timeline */}
      <div id="replaybar">
        {!replay ? (
          <button className="btn" onClick={enterReplay} title="Scrub recorded snapshots over time">⏱ Replay</button>
        ) : (
          <>
            <button className="btn" onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚' : '▶'}</button>

            {/* Step the window a whole page back, and forward again. This is
                what reaching 48 hours looks like from the browser's side: the
                archive holds it, the tab holds one page of it. Disabled at the
                edge of what the archive actually has rather than at a nominal
                48h, so the control cannot promise history that was never
                recorded. */}
            <button
              className="btn"
              disabled={!canPageBack}
              title={canPageBack ? `Back ${formatSpan(replaySpanMs)}` : 'No earlier frames in the archive'}
              onClick={() => { setPlaying(false); pageWindow(-1); }}
            >⏮</button>

            <input type="range" min={0} max={Math.max(0, timeline.length - 1)} value={Math.min(frameIdx, timeline.length - 1)}
              onChange={(e) => { setPlaying(false); setFrameIdx(+e.target.value); }} />

            <button
              className="btn"
              disabled={!canPageForward}
              title={canPageForward ? `Forward ${formatSpan(replaySpanMs)}` : 'Already at the most recent frames'}
              onClick={() => { setPlaying(false); pageWindow(1); }}
            >⏭</button>

            <select
              className="replay-span"
              value={replaySpanMs}
              title="How much time the scrub bar covers"
              onChange={(e) => {
                const span = Number(e.target.value);
                setPlaying(false);
                setReplaySpanMs(span);
                const to = replayWindow?.to ?? Date.now();
                setReplayWindow({ from: to - span, to });
              }}
            >
              <option value={15 * 60 * 1000}>15 min</option>
              <option value={60 * 60 * 1000}>1 hour</option>
              <option value={6 * 60 * 60 * 1000}>6 hours</option>
              <option value={24 * 60 * 60 * 1000}>24 hours</option>
              <option value={48 * 60 * 60 * 1000}>48 hours</option>
            </select>

            <span className="rt">
              {windowLoading
                ? 'loading…'
                : timeline.length
                  ? new Date(timeline[Math.min(frameIdx, timeline.length - 1)]).toLocaleString(undefined,
                      { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  : '—'}
              <span className="muted">
                {/* What the archive actually holds, which is not the same as
                    what was asked for. A 48-hour selection on a service that
                    has been up for twenty minutes must not imply two days of
                    history exists. */}
                {archiveExtent
                  ? ` · ${formatSpan(archiveExtent.to - archiveExtent.from)} archived`
                  : ' · nothing archived yet — the window fills as the feeds poll'}
              </span>
            </span>

            <button className="btn live" onClick={() => { setReplay(false); setPlaying(false); }}>● LIVE</button>
          </>
        )}
      </div>

      {/* Phone navigation. The side panels become one bottom sheet and this
          chooses which one is showing; tapping the open tab closes it. Hidden
          above the phone breakpoint, where all of them are on screen at once.
          Tabs appear only when their panel has something to show, so an absent
          tab means an absent panel rather than a hidden one. */}
      <nav className="mobile-tabbar">
        {[
          ['layers', 'Layers', 0],
          ...(caseFiles.length ? [['cases', 'Cases', caseFiles.length]] : []),
          ['detail', 'Detail', alerts.length],
          ...(selection && (intelLoading || intel) ? [['intel', 'Intel', 0]] : []),
          ['feeds', 'Feeds', downFeedCount],
        ].map(([id, label, badge]) => (
          <button
            key={id}
            className={`mobile-tab ${mobileSheet === id ? 'on' : ''} ${id === 'feeds' && downFeedCount ? 'warn' : ''}`}
            aria-pressed={mobileSheet === id}
            onClick={() => setMobileSheet((s) => (s === id ? null : id))}
          >
            {label}{badge > 0 ? <span className="mobile-tab-badge">{badge}</span> : null}
          </button>
        ))}
      </nav>

      {/* footer */}
      <footer id="statusbar">
        <span>
          {replay ? 'REPLAY' : `${liveContacts} live contacts`}
          {!replay && degradedContacts > 0 && (
            <span className="muted"> · {degradedContacts} not live</span>
          )}
          {' · '}{activeLayers.length} layers · {ctx.name}
        </span>
        <span className="spacer" />
        <span className="muted status-tagline">Keyless public sources · AI ontology · object detection · detection workflows · time replay</span>
      </footer>
    </>
  );
}
