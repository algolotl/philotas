// GET /api/casefiles?region=<id> — confirmed events worth reviewing, each with
// its recorded frame range and an assessment.
//
// This is what makes the trial reliable: a visitor can open something real that
// already happened instead of waiting for the harbour to misbehave while they
// watch.
import { getRegion } from '@/lib/regions';
import { getCaseFiles } from '@/lib/casefiles/service';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const region = getRegion(new URL(req.url).searchParams.get('region'));
  const files = await getCaseFiles(region);

  return Response.json(
    {
      region: region.id,
      count: files.length,
      // Stated explicitly so a consumer cannot mistake these for live events.
      recorded: true,
      files,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
