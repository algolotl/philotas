// GET /api/status?region=<id> — compact per-feed health for the header strip.
//
// The region matters. Feeds are region-parameterised — bbox, weather station,
// news query, which transport modes — so health for one region says nothing
// about another. This previously called getFeed(key) with no region at all,
// which reported on a phantom region nobody was viewing: an operator watching
// Sydney would see a healthy transport light powered by two Canberra trams.
//
// Only the region's active layers are reported, so the strip shows what is
// actually on the map rather than every feed the build knows about.
import { FETCHERS, getFeed } from '@/lib/cache';
import { feedResultIsLive } from '@/lib/feed-health';
import { getRegion } from '@/lib/regions';
import { requireUser } from '@/lib/guard';
import { atLeast } from '@/lib/auth';
import { startupSchemaHealth } from '@/lib/schema/startup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  // Read surface requires a session. See lib/guard.js.
  //
  // The user is kept, not discarded. The gate above is a yes/no on reading this
  // route at all; the schema detail below is a second, narrower question about
  // the same request, and answering it needs the role. Calling requireUser a
  // second time with minRole:'operator' would work and would be wrong twice
  // over — a second datastore round trip per request, and a 403 response object
  // built and thrown away to be read as a boolean.
  const { user, response: denied } = await requireUser(req);
  if (denied) return denied;

  const region = getRegion(new URL(req.url).searchParams.get('region'));
  const keys = (region.layers || []).filter((key) => FETCHERS[key]);

  const out = {};
  await Promise.all(
    keys.map(async (key) => {
      const r = await getFeed(key, region);
      out[key] = {
        count: r.payload.features?.length ?? 0,
        error: r.error || null,
        stale: !!r.stale,
        fetched_at: r.at,
        // Which upstream actually produced this payload — 'tfnsw+portauthority'
        // for a merged vessel picture, 'live' or 'bundled' for cameras. The UI
        // names the feed rather than asserting a generic "live".
        source: r.payload.source || null,
        notice: r.payload.notice || null,
        // Whether the data is CURRENT, which is a separate question from
        // whether the feed has anything to say about itself. Both the feed's own
        // claim and the cache's judgement on an archived payload have to agree,
        // and the rule is in lib/feed-health.js rather than written out here —
        // it was written out here AND in app/api/feeds/[feed]/route.js, two
        // copies of one sentence that nothing could import and no test could
        // reach. The tests that meant to pin it restated it against object
        // literals instead, and could not have failed whatever these routes did.
        live: feedResultIsLive(r),
        // Set when this payload came off the durable archive rather than from a
        // live call — after a restart, or while an upstream is refusing us. The
        // UI says how old it is; showing recorded data as current is the one
        // thing this product must not do.
        from_archive_ms: r.from_archive_ms || null,
        // Still fetching for the first time, as opposed to genuinely empty.
        pending: !!r.pending,
      };
    })
  );
  return Response.json(
    {
      region: region.id,
      feeds: out,
      // The boot-time semantic schema apply, READ and never re-run. Nothing used
      // to read it, so a deployment whose DDL was refused looked identical to a
      // healthy one and retrieval returned nothing forever with no signal
      // anywhere a user could reach.
      //
      // The classification lives in lib/schema/startup.js, beside the table of
      // outcomes it implements, rather than being decided here — the same reason
      // the combined liveness verdict above lives in lib/feed-health.js. Two
      // things it must not do: read the `applied` flag as the verdict, since a
      // no-op re-apply is healthy and reports false; and merge the two failure
      // reasons, since one means the database refused a connection and the other
      // means it refused the DDL.
      //
      // Calling ensureSemanticSchema() from here instead would trip its
      // once-per-process guard on the first request served, so the read is the
      // whole contract.
      //
      // `status` and `reason` go to every reader, because the header strip needs
      // both and because `reason` is what keeps the two degradations apart. The
      // driver message goes to an operator only: for pool-failed it is Node's
      // `connect ECONNREFUSED <host>:<port>`, which is the host and port of
      // DATABASE_URL. The read gate above is viewer-level, so without this a
      // logged-in viewer read it — on a public trial, the guest account — and
      // with PARALLAX_OPEN_READ=1 (lib/guard.js:18) anyone at all did.
      //
      // atLeast is lib/auth.js's rank check, the same one lib/guard.js uses, so
      // there is one notion of role in the build and admin is covered by being
      // above operator rather than by being listed. `user` is null on the
      // open-read path, and an absent role ranks below everything (lib/auth.js:36),
      // so that path resolves to false rather than to a default.
      schema: startupSchemaHealth({ includeDetail: atLeast(user?.role, 'operator') }),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
