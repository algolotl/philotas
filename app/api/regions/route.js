// GET /api/regions — the list of available regions for the switcher.
import { REGION_LIST } from '@/lib/regions';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  return Response.json({ regions: REGION_LIST });
}
