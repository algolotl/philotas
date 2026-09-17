// GET /api/ontology?region=<id> — induced model + resolved cross-source links.
import { getRegion } from '@/lib/regions';
import { getOntology } from '@/lib/ontology/service';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const region = getRegion(new URL(req.url).searchParams.get('region'));
  const artifact = await getOntology(region);
  return Response.json(artifact, { headers: { 'Cache-Control': 'no-store' } });
}
