// Cached ontology accessor, shared by /api/ontology and /api/search so the
// resolve pass (and any LLM adjudication) runs at most once per region per TTL.

import { getFeed } from '../cache.js';
import { buildOntology, induceEntities } from './build.js';

const cache = new Map(); // regionId -> { at, artifact }
const TTL = 15_000;

// Profiles are refreshed on a slower clock than the ontology itself. The artifact
// is rebuilt every 15 seconds and the induced entity set barely moves between
// rebuilds, so re-checking every profile that often would spend the embedder's
// budget discovering that nothing changed. Opportunistic rather than on a timer,
// matching lib/corpus/service.js: a deployment with no traffic does not spend its
// budget on nobody.
const PROFILE_REFRESH_INTERVAL_MS = 5 * 60_000;   // **assumed**
let lastProfileRefreshAt = 0;
let profileRefreshRunning = false;
let lastProfileRefresh = null;

/** What the last profile refresh did, or null if none has run in this process. */
export function lastProfileRefreshResult() { return lastProfileRefresh; }

// `entitiesFor` is a thunk rather than an array: inducing the entity set is a
// second pass over every feature in every feed, and this function returns without
// needing it on all but one call in twenty.
async function refreshProfiles(entitiesFor) {
  const now = Date.now();
  if (profileRefreshRunning || now - lastProfileRefreshAt < PROFILE_REFRESH_INTERVAL_MS) return;
  profileRefreshRunning = true;
  lastProfileRefreshAt = now;
  try {
    // Imported here rather than at module scope, the same shape lib/corpus/
    // service.js uses for its store: the ontology artifact needs no database at
    // all, and a static import would put pg in the dependency graph of every
    // route that reads one.
    //
    // INSIDE the try because semanticPool() has three outcomes, not two — it can
    // reject, which is what an unreachable Postgres does on the first call after
    // boot. Outside, that rejection would be an unhandled one.
    const { semanticPool } = await import('../db.js');
    const pool = await semanticPool();
    if (!pool) { lastProfileRefresh = { skipped: 'no-corpus-store' }; return; }

    const { upsertEntityProfiles } = await import('./profiles.js');
    lastProfileRefresh = await upsertEntityProfiles(pool, entitiesFor());
    if (lastProfileRefresh.degraded) {
      console.warn(`[profiles] refresh degraded: ${lastProfileRefresh.degraded}`);
    }
  } catch (err) {
    // Named. A profile refresh failing must not cost the caller its ontology
    // artifact, which needs no database at all.
    lastProfileRefresh = { degraded: 'profile-refresh-failed', detail: String(err?.message || err) };
    console.error(`[profiles] refresh failed: ${lastProfileRefresh.detail}`);
  } finally {
    profileRefreshRunning = false;
  }
}

export async function getOntology(region) {
  const now = Date.now();
  const hit = cache.get(region.id);
  if (hit && now - hit.at < TTL) return hit.artifact;

  const feeds = {};
  await Promise.all(region.layers.map(async (k) => { feeds[k] = (await getFeed(k, region)).payload; }));
  const artifact = await buildOntology(feeds);
  cache.set(region.id, { at: now, artifact });
  // Deliberately not awaited: this is a request path and profile writes are
  // background work. The promise is caught so a rejection cannot take the process
  // down, and the entity set is passed as a thunk so a refresh that is not due
  // costs nothing at all.
  refreshProfiles(() => induceEntities(feeds)).catch((err) =>
    console.error(`[profiles] refresh rejected: ${err?.message || err}`)
  );
  return artifact;
}
