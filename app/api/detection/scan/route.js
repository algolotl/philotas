// POST /api/detection/scan — run detection over every live camera still in a
// region, record the rows, and let workflows evaluate them. This is the
// 'identify something on the map' entry point: the operator picks a region
// (or a single camera via /detect) and the model looks at what each camera
// sees right now.
import { getRegion } from '@/lib/regions';
import { fetchCameras } from '@/lib/feeds/cameras';
import { detectImage, normaliseDetections } from '@/lib/detection';
import { addDetections } from '@/lib/db';
import { runWorkflowPass } from '@/lib/workflows';
import { currentUser, atLeast } from '@/lib/auth';
import { requireUser } from '@/lib/guard';
import { audit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Bound the sweep: TfNSW serves ~200 statewide cameras and each still is a
// separate detection call. The region clip already narrows it; this is the
// stop-loss if a region box ever grows.
const MAX_CAMERAS = 25;
// Two cameras in flight at once, so a sweep of 25 lands in ~13 round trips
// rather than 25 serial ones, without hammering the model worker.
const CONCURRENCY = 2;

export async function POST(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });

  const { region: regionId, cameraIds } = await req.json().catch(() => ({}));
  const region = getRegion(regionId);
  if (!region) return Response.json({ error: 'unknown region' }, { status: 400 });

  let fc;
  try {
    fc = await fetchCameras(region);
  } catch (err) {
    return Response.json({ error: 'camera feed unavailable: ' + String(err.message || err) }, { status: 502 });
  }

  const wanted = new Set(Array.isArray(cameraIds) ? cameraIds : null);
  const cameras = (fc.features || [])
    .filter((f) => f.properties?.image && (!wanted.size || wanted.has(f.properties.title) || wanted.has(f.properties.id)))
    .slice(0, MAX_CAMERAS);

  if (!cameras.length) {
    return Response.json({ error: 'no live camera stills in this region — set CCTV_GEOJSON_URL for imagery', cameras: 0, detections: 0 }, { status: 200 });
  }

  const errors = [];
  let rows = [];
  const queue = [...cameras];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const p = f.properties;
      try {
        const raw = (await detectImage({ image: p.image })).detections || [];
        rows = rows.concat(normaliseDetections(raw, {
          region: region.id, source: 'camera', sourceId: p.title || p.id, coord: f.geometry?.coordinates || null,
        }));
      } catch (err) {
        errors.push({ camera: p.title || p.id, error: String(err.message || err) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (rows.length) await addDetections(rows);
  await runWorkflowPass(region.id, rows).catch(() => {});
  await audit(user.username, 'vision.scan', region.id + ' · ' + cameras.length + ' cameras · ' + rows.length + ' detections').catch(() => {});
  return Response.json({ cameras: cameras.length, detections: rows.length, errors });
}