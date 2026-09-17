// POST /api/detection/video — sample frames from a video feed URL and record
// the detections. Payload: { url, coord?, region }. The service decides the
// sampling rate; every detection row carries the frame time where known.
import { detectVideo, normaliseDetections } from '@/lib/detection';
import { addDetections } from '@/lib/db';
import { runWorkflowPass } from '@/lib/workflows';
import { currentUser, atLeast } from '@/lib/auth';
import { requireUser } from '@/lib/guard';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });

  const { url, coord, region } = await req.json().catch(() => ({}));
  if (!url || !/^https?:\/\//i.test(url)) return Response.json({ error: 'a video feed URL is required' }, { status: 400 });

  let result;
  try {
    result = await detectVideo({ url });
  } catch (err) {
    return Response.json({ error: String(err.message || err) }, { status: 503 });
  }

  // result.frames: [{ t_ms, detections: [...] }] — flatten into rows.
  const rows = [];
  const t0 = result.started_at_ms || Date.now();
  for (const frame of result.frames || []) {
    const at = frame.t_ms != null ? t0 + frame.t_ms : Date.now();
    rows.push(...normaliseDetections(frame.detections || [], {
      region: region || null, source: 'video', sourceId: url, coord: coord || null, detectedAtMs: at,
    }));
  }
  if (rows.length) await addDetections(rows);
  if (region) await runWorkflowPass(region, rows).catch(() => {});
  await audit(user.username, 'vision.video', (result.frames || []).length + ' frames · ' + rows.length + ' detections').catch(() => {});
  return Response.json({ frames: (result.frames || []).length, detections: rows.length, rows });
}