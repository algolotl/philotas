// GET /api/context?region=<id> — the map setup for a region (centre, sites,
// active layers, demo arc).
import { getRegion } from '@/lib/regions';
import { FEEDS } from '@/lib/config';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const region = getRegion(new URL(req.url).searchParams.get('region'));
  return Response.json({
    region: region.id,
    name: region.name,
    center: region.center,
    zoom: region.zoom,
    sites: region.sites,
    layers: region.layers,
    arc: region.arc,
    feeds: region.layers.map((id) => ({ id, label: FEEDS[id]?.label || id })),
  });
}
