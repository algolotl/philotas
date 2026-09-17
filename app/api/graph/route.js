// GET /api/graph?region=<id> — the region's entities and resolved relationships
// as a node-link graph (built from the ontology pass). This is the knowledge
// graph the UI renders: nodes are entities (aircraft, cafes, quakes, articles…),
// edges are the resolved links (tracks / mentions / context / same-as).
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
  const art = await getOntology(region);
  const links = art.links || [];

  const nodes = new Map();
  const node = (label, type, coord) => {
    const id = `${type}:${label}`;
    if (!nodes.has(id)) nodes.set(id, { id, label, type, coord: coord || null, degree: 0 });
    const n = nodes.get(id);
    if (!n.coord && coord) n.coord = coord;
    n.degree += 1;
    return id;
  };

  const edges = links.map((l) => ({
    from: node(l.fromLabel, l.fromType, l.fromCoord),
    to: node(l.toLabel, l.toType, l.toCoord),
    type: l.type, confidence: l.confidence, method: l.method,
  }));

  return Response.json({
    region: region.id,
    method: art.method,
    nodes: [...nodes.values()],
    edges,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
