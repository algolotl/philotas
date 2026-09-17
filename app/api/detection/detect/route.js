// POST /api/detection/detect — run object detection over one image and record
// the result. Payload: { image (url or data URL), source, sourceId, coord, region }.
// The image itself is never persisted — only the detection rows are.
import { getRegion } from '@/lib/regions';
import { detectImage, normaliseDetections } from '@/lib/detection';
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

  const { image, source, sourceId, coord, region: regionId } = await req.json().catch(() => ({}));
  if (!image) return Response.json({ error: 'image is required (URL or data URL)' }, { status: 400 });

  let raw;
  try {
    raw = (await detectImage({ image })).detections || [];
  } catch (err) {
    return Response.json({ error: String(err.message || err) }, { status: 503 });
  }

  const rows = normaliseDetections(raw, { region: regionId || null, source, sourceId, coord });
  if (rows.length) await addDetections(rows);
  if (regionId) await runWorkflowPass(regionId, rows).catch(() => {});
  await audit(user.username, 'vision.detect', (source || 'image') + ' · ' + rows.length + ' detections').catch(() => {});
  return Response.json({ detections: rows });
}