// GET /api/casefiles/<id>?region=<id> — one case file plus the recorded frames
// needed to replay it.
//
// The frames come from the same rolling snapshot store that powers time-replay,
// clipped to the case file's window. Nothing is generated here; if a layer has
// no recorded frames covering the moment it is simply absent, which is why the
// list endpoint reports `replayable_layers`.
import { getRegion } from '@/lib/regions';
import { getCaseFile } from '@/lib/casefiles/service';
import { history } from '@/lib/store';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req, { params }) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const { id } = await params;
  const region = getRegion(new URL(req.url).searchParams.get('region'));
  const file = await getCaseFile(region, decodeURIComponent(id));
  if (!file) return Response.json({ error: 'case file not found' }, { status: 404 });

  const frames = {};
  for (const layer of file.replayable_layers || []) {
    const clipped = history(layer, region.id, 60)
      .filter((f) => f.t >= file.frame_from_ms && f.t <= file.frame_to_ms);
    if (clipped.length) frames[layer] = clipped;
  }

  return Response.json(
    { region: region.id, file, frames, recorded: true },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
