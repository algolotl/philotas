// GET /api/history/<feed>?region=<id>&from=<ms>&to=<ms>&max=<n>
//
// Recorded snapshots for time-replay, read from the durable archive in
// lib/frames.js. Each frame is a timestamped FeatureCollection.
//
// The window is REQUIRED to be bounded. An earlier version of this route took
// `n=<frames>` and returned the most recent n, which was workable while the
// history lived in memory and was two hours long. The archive holds 48 hours
// across a dozen layers, and the Sydney transport layer alone is 300 KB a
// frame — handing the browser all of it would be hundreds of megabytes. So the
// client asks for the span it is showing and pans.
//
// Without `from`/`to` this returns the most recent hour, which is what an
// operator opening the replay bar wants to see first.

import { FETCHERS, getFeed } from '@/lib/cache';
import { framesBetween, coverage, ARCHIVE_INTERVAL_MS, RETENTION_MS } from '@/lib/frames';
import { getRegion } from '@/lib/regions';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
// A ceiling on frames per response, not on the span. framesBetween thins a
// wider window by stride rather than truncating it, so asking for two days
// returns two days at lower resolution instead of the first hour of it.
const MAX_FRAMES = 240;

export async function GET(req, { params }) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const { feed } = await params;
  if (!FETCHERS[feed]) return Response.json({ error: `unknown feed: ${feed}` }, { status: 404 });

  const url = new URL(req.url);
  const region = getRegion(url.searchParams.get('region'));

  // Touch the feed so its poller is running and it is contributing frames.
  await getFeed(feed, region);

  const now = Date.now();
  const oldestKeepable = now - RETENTION_MS;

  const to = Math.min(Number(url.searchParams.get('to')) || now, now);
  const requestedFrom = Number(url.searchParams.get('from')) || to - DEFAULT_WINDOW_MS;
  // Clamping rather than erroring: a client asking for a week is asking for
  // everything we have, and the response says what it actually covers.
  const from = Math.max(requestedFrom, oldestKeepable);

  const max = Math.min(Number(url.searchParams.get('max')) || MAX_FRAMES, MAX_FRAMES);

  const [frames, extent] = await Promise.all([
    framesBetween(feed, region.id, from, to, max),
    coverage(feed, region.id),
  ]);

  return Response.json(
    {
      feed,
      region: region.id,
      // What was asked for and what was served, separately. A window that got
      // thinned or clamped must not be reported as though it came back whole.
      requested: { from, to },
      step_ms: ARCHIVE_INTERVAL_MS,
      retention_ms: RETENTION_MS,
      // The full extent of what the archive holds for this feed, so the client
      // can size its scrub bar to real history rather than to a guess.
      archive: extent,
      frames,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
