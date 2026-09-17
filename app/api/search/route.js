// GET /api/search?region=<id>&q=<text> — full-text search across the region's
// live entities, each result carrying its resolved ontology connections (the
// link-exploration surface: find a thing, then see what it's linked to).
import { getFeed, FETCHERS } from '@/lib/cache';
import { getRegion } from '@/lib/regions';
import { getOntology } from '@/lib/ontology/service';
import { LAYERS } from '@/lib/layers';
import { requireUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const COLOR = Object.fromEntries(LAYERS.map((l) => [l.id, l.color]));

function entityTitle(p) {
  return p.title || p.callsign || p.friendly || p.norad || p.id || '';
}

export async function GET(req) {
  // Read surface requires a session. See lib/guard.js.
  const { response: denied } = await requireUser(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const region = getRegion(url.searchParams.get('region'));
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (q.length < 2) return Response.json({ q, results: [], total: 0 });

  // Gather the region's live entities.
  const feeds = {};
  await Promise.all(region.layers.filter((k) => FETCHERS[k]).map(async (k) => { feeds[k] = (await getFeed(k, region)).payload; }));

  const matches = [];
  for (const [layer, fc] of Object.entries(feeds)) {
    for (const f of fc.features || []) {
      const p = f.properties || {};
      const title = entityTitle(p);
      const hay = `${title} ${Object.values(p).join(' ')}`.toLowerCase();
      if (hay.includes(q)) {
        matches.push({ layer, color: COLOR[layer] || '#9ca3af', title: title || layer, coord: f.geometry?.coordinates || null });
        if (matches.length >= 60) break;
      }
    }
  }

  // Attach ontology connections (cached; no extra resolve/LLM cost).
  const art = await getOntology(region);
  const links = art.links || [];
  for (const m of matches) {
    m.connections = links
      .filter((l) => l.fromLabel === m.title || l.toLabel === m.title)
      .map((l) => ({ type: l.type, other: l.fromLabel === m.title ? l.toLabel : l.fromLabel, confidence: l.confidence }));
  }

  return Response.json({ q, total: matches.length, results: matches.slice(0, 40) });
}
