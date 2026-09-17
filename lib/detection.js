// Server-side client for the Python object-detection service (detect/).
//
// The service implements /health, /detect, /detect_video and /similar and is
// addressed by DETECTION_URL (default http://127.0.0.1:8770). Every call here
// fails soft: a route that cannot reach the service returns a 503-shaped error
// the VISION panel renders as a hint rather than a stack trace.

import crypto from 'node:crypto';

const DETECTION_URL = (process.env.DETECTION_URL || 'http://127.0.0.1:8770').replace(/\/+$/, '');

export function detectionServiceUrl() { return DETECTION_URL; }

async function callService(path, { method = 'POST', body, timeoutMs = 45_000 } = {}) {
  const res = await fetch(DETECTION_URL + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error || j.detail || ('detection service responded ' + res.status));
    err.status = res.status;
    throw err;
  }
  return j;
}

// Never throws: the health check is a status read, and the panel must be able
// to render 'offline' rather than fail the poll.
export async function detectionHealth() {
  try {
    return await callService('/health', { method: 'GET', timeoutMs: 6_000 });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Run detection over one image. `payload.image` is a URL or a data: URL.
export const detectImage = (payload) => callService('/detect', { body: payload, timeoutMs: 60_000 });

// Sample a video feed's frames and detect on each sample.
export const detectVideo = (payload) => callService('/detect_video', { body: payload, timeoutMs: 120_000 });

// Rank candidate images by similarity to a query (optionally cropped by bbox).
export const findSimilarImages = (payload) => callService('/similar', { body: payload, timeoutMs: 90_000 });

// The service's own label for a detection is 'class' under both engines, but
// older or third-party engines may call it 'label' or 'name'. Normalise once
// here so every consumer (db, workflows, panel) reads one field.
export function normaliseDetections(raw, { region, source, sourceId, coord, detectedAtMs } = {}) {
  return (raw || [])
    .map((d) => ({
      ...d,
      class: String(d.class || d.label || d.name || 'object'),
      score: Number(d.score != null ? d.score : d.confidence != null ? d.confidence : 0),
      bbox: Array.isArray(d.bbox) && d.bbox.length === 4 ? d.bbox.map(Number) : null,
    }))
    .filter((d) => d.class)
    .map((d) => ({
      id: crypto.randomUUID(),
      region: region || null,
      source: source || 'vision',
      sourceId: sourceId || null,
      class: d.class,
      score: d.score,
      bbox: d.bbox,
      detected_at_ms: detectedAtMs || Date.now(),
      coord: coord || null,
      image: null,
    }));
}