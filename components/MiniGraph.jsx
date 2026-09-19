'use client';

import { useEffect, useMemo, useState } from 'react';
import { getJson } from '@/lib/fetch-json';

// Always-on mini knowledge graph, pinned to a corner of the map. A compact
// node-link minimap of the region's resolved ontology; click a node to fly the
// map, click ⤢ to open the full Knowledge panel. Collapsible.

const TYPE_COLOR = {
  Aircraft: '#38bdf8', Satellite: '#e2e8f0', GroundStation: '#a78bfa', Spacecraft: '#c4b5fd',
  FireIncident: '#f97316', Earthquake: '#fbbf24', WeatherStation: '#34d399', NewsArticle: '#f472b6',
  Cafe: '#c084fc', Vehicle: '#22d3ee', Camera: '#94a3b8', Facility: '#a3e635',
};
const W = 300, H = 200;

function layout(nodes, edges) {
  const pos = nodes.map((n, i) => ({ x: W / 2 + Math.cos(i * 1.7) * (50 + i * 2.5), y: H / 2 + Math.sin(i * 1.7) * (45 + i * 2) }));
  const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
  const iters = nodes.length > 50 ? 80 : 150;
  for (let it = 0; it < iters; it++) {
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y; const d2 = dx * dx + dy * dy + 0.01;
      const d = Math.sqrt(d2), f = 600 / d2; dx /= d; dy /= d;
      pos[a].x += dx * f; pos[a].y += dy * f; pos[b].x -= dx * f; pos[b].y -= dy * f;
    }
    for (const e of edges) {
      const a = idx[e.from], b = idx[e.to]; if (a == null || b == null) continue;
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y; const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 32) * 0.03; dx /= d; dy /= d;
      pos[a].x -= dx * f; pos[a].y -= dy * f; pos[b].x += dx * f; pos[b].y += dy * f;
    }
    for (let k = 0; k < nodes.length; k++) { pos[k].x += (W / 2 - pos[k].x) * 0.01; pos[k].y += (H / 2 - pos[k].y) * 0.01; }
  }
  for (const p of pos) { p.x = Math.max(10, Math.min(W - 10, p.x)); p.y = Math.max(10, Math.min(H - 10, p.y)); }
  return pos;
}

export default function MiniGraph({ region, onExpand, onPick, authReady }) {
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!authReady) return;
    // Clear the previous region's graph up front: a failed or slow fetch must
    // not leave Sydney's entities sitting under a region that has since moved
    // (the map re-aims immediately, the graph used to lag a whole poll behind).
    setGraph({ nodes: [], edges: [] });
    const pull = () => getJson(`/api/graph?region=${region}`).then(setGraph).catch(() => setGraph({ nodes: [], edges: [] }));
    pull();
    const t = setInterval(pull, 20_000);
    return () => clearInterval(t);
  }, [region, authReady]);

  // Defence in depth. getJson already keeps a bad response out of state; this
  // makes a malformed one non-fatal rather than a render-time crash.
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const pos = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const idx = useMemo(() => Object.fromEntries(nodes.map((n, i) => [n.id, i])), [nodes]);

  if (!open) {
    return <button className="mini-graph-pill" onClick={() => setOpen(true)} title="Show knowledge graph">◉ graph</button>;
  }

  return (
    <div className="mini-graph">
      <div className="mini-graph-head">
        <span>GRAPH · {graph.nodes.length} entities</span>
        <span className="mini-graph-btns">
          <button onClick={onExpand} title="Open full knowledge graph">⤢</button>
          <button onClick={() => setOpen(false)} title="Hide">–</button>
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="160">
        {graph.edges.map((e, i) => {
          const a = pos[idx[e.from]], b = pos[idx[e.to]]; if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#3a4a60" strokeWidth="0.7" strokeOpacity="0.6" />;
        })}
        {graph.nodes.map((n, i) => {
          const p = pos[i]; if (!p) return null;
          return <circle key={n.id} cx={p.x} cy={p.y} r={Math.min(6, 2.5 + n.degree * 0.7)} fill={TYPE_COLOR[n.type] || '#9ca3af'}
            stroke="#0a0e14" strokeWidth="0.6" style={{ cursor: n.coord ? 'pointer' : 'default' }}
            onClick={() => n.coord && onPick?.(n)}><title>{`${n.label} (${n.type})`}</title></circle>;
        })}
        {graph.nodes.length === 0 && <text x={W / 2} y={H / 2} textAnchor="middle" fill="#6b7c93" fontSize="11">resolving…</text>}
      </svg>
    </div>
  );
}
