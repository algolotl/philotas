// POST /api/detection/similar — 'find other instances of this'. Ranks a set of
// candidate images (other camera stills, video frames) by similarity to a
// query image, optionally cropped to a detection's bbox.
import { findSimilarImages } from '@/lib/detection';
import { currentUser, atLeast } from '@/lib/auth';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req) {
  const { response: denied } = await requireUser(req);
  if (denied) return denied;
  const user = await currentUser(req);
  if (!user || !atLeast(user.role, 'operator')) return Response.json({ error: 'operator role required' }, { status: 403 });

  const { query, bbox, candidates } = await req.json().catch(() => ({}));
  if (!query || !Array.isArray(candidates) || !candidates.length) {
    return Response.json({ error: 'query and candidates[] are required' }, { status: 400 });
  }

  let ranked;
  try {
    const res = await findSimilarImages({
      query,
      bbox: Array.isArray(bbox) && bbox.length === 4 ? bbox : null,
      candidates: candidates.slice(0, 60).map((c) => ({ id: c.id, image: c.image })),
    });
    ranked = res.matches || res.scores || [];
  } catch (err) {
    return Response.json({ error: String(err.message || err) }, { status: 503 });
  }

  // Map the service's ranked ids back onto the candidates, preserving coord.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const matches = ranked
    .map((r) => {
      const c = byId.get(r.id);
      return { id: r.id, score: Number(r.score ?? 0), image: c?.image, coord: c?.coord || null };
    })
    .sort((a, b) => b.score - a.score);
  return Response.json({ matches });
}