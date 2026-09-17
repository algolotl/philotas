// GET /api/detection/health — object-detection service status.
import { detectionHealth, detectionServiceUrl } from '@/lib/detection';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;
  const health = await detectionHealth();
  return Response.json({ ...health, url: detectionServiceUrl() }, { headers: { 'Cache-Control': 'no-store' } });
}