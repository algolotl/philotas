// GET /api/detections?region=<id>&class=<label> — recent stored detections.
import { listDetections } from '@/lib/db';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;
  const u = new URL(req.url);
  const region = u.searchParams.get('region') || undefined;
  const classes = u.searchParams.get('class') ? u.searchParams.get('class').split(',') : undefined;
  const detections = await listDetections({ region, classes, limit: 50 });
  return Response.json({ count: detections.length, detections }, { headers: { 'Cache-Control': 'no-store' } });
}