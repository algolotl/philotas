// GET /api/intel?region=<id>&key=<entityKey>  — open-source intelligence for one
// entity: the documents that mention it, the entities it shares documents with,
// and any bounded hypotheses that survived governance.
//
// GET /api/intel?region=<id>                  — corpus status for the region.
//
// The background enrichment pass is nudged from here rather than run on a timer.
// A deployment nobody is looking at should not be spending its source quota, and
// the sources involved already rate-limit us under normal application load.
import { getRegion } from '@/lib/regions';
import { getEntityIntel, runEnrichmentPass, searchableEntities } from '@/lib/corpus/service';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const region = getRegion(url.searchParams.get('region'));
  const key = url.searchParams.get('key');

  // Opportunistic, rate-limited, and never allowed to delay the response.
  runEnrichmentPass(region).catch(() => {});

  if (!key) {
    const entities = await searchableEntities(region).catch(() => []);
    return Response.json(
      { region: region.id, searchable_entities: entities.length, entities: entities.slice(0, 50) },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const intel = await getEntityIntel(region, key, {
    entityType: url.searchParams.get('type') || undefined,
    entityLabel: url.searchParams.get('label') || undefined,
  });

  return Response.json(
    {
      region: region.id,
      ...intel,
      // Stated on every response so a consumer cannot mistake a hypothesis for
      // a resolved link. The distinction is the whole point of the feature.
      hypotheses_are_unverified: true,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
