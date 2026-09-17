// GET /api/feeds/<feed>?region=<id> — normalized GeoJSON for one layer.
import { FEEDS } from '@/lib/config';
import { FETCHERS, getFeed } from '@/lib/cache';
import { feedResultIsLive } from '@/lib/feed-health';
import { getRegion } from '@/lib/regions';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // protobuf decode + http (BoM) need Node, not Edge

export async function GET(req, { params }) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const { feed } = await params;
  if (!FETCHERS[feed]) {
    return Response.json({ error: `unknown feed: ${feed}` }, { status: 404 });
  }

  const region = getRegion(new URL(req.url).searchParams.get('region'));
  const r = await getFeed(feed, region);
  return Response.json(
    {
      feed,
      label: FEEDS[feed].label,
      fetched_at: r.at,
      error: r.error || null,
      stale: !!r.stale,
      // When the payload came off the durable archive rather than a live call.
      // Spread before ...r.payload so a feed can never overwrite it with its
      // own field of the same name.
      from_archive_ms: r.from_archive_ms || null,
      // True when the first-ever fetch for this feed was still running when the
      // cold-start budget expired. An empty layer that is still loading and an
      // empty layer that has nothing to show look identical otherwise, and only
      // one of them is worth waiting on.
      pending: !!r.pending,
      count: r.payload.features?.length ?? 0,
      ...r.payload,
      // After the spread, because this is the combined verdict: the feed's own
      // claim AND the cache's judgement on how old an archived payload is. The
      // payload's bare `live` would otherwise win and lose half the answer.
      // Same function app/api/status/route.js calls — the two used to carry a
      // character-identical copy each, which is the arrangement that has already
      // let one liveness rule drift from another five times in this project.
      live: feedResultIsLive(r),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
