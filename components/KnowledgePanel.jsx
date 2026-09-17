'use client';

import { useEffect, useMemo, useState } from 'react';
import { getJson } from '@/lib/fetch-json';

// Full-screen "Knowledge" overlay: a searchable news list (left) and the entity
// graph built from the ontology (right). Selecting a graph node filters the news
// to articles linked to that entity and flies the map there; entities and the
// stories about them, in one place.

const TYPE_COLOR = {
  Aircraft: '#38bdf8', Satellite: '#e2e8f0', GroundStation: '#a78bfa', Spacecraft: '#c4b5fd',
  FireIncident: '#f97316', Earthquake: '#fbbf24', WeatherStation: '#34d399', NewsArticle: '#f472b6',
  Cafe: '#c084fc', Vehicle: '#22d3ee', Camera: '#94a3b8', Facility: '#a3e635',
};
const W = 760, H = 560;

// Lightweight spring-electric layout (deterministic init so it's stable).
function layout(nodes, edges) {
  const pos = nodes.map((n, i) => ({ x: W / 2 + Math.cos(i * 1.7) * (120 + i * 4), y: H / 2 + Math.sin(i * 1.7) * (110 + i * 3) }));
  const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
  const iters = nodes.length > 60 ? 120 : 220;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      let dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y; const d2 = dx * dx + dy * dy + 0.01;
      const d = Math.sqrt(d2), f = 2600 / d2; dx /= d; dy /= d;
      pos[i].x += dx * f; pos[i].y += dy * f; pos[j].x -= dx * f; pos[j].y -= dy * f;
    }
    for (const e of edges) {
      const a = idx[e.from], b = idx[e.to]; if (a == null || b == null) continue;
      let dx = pos[a].x - pos[b].x, dy = pos[a].y - pos[b].y; const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 70) * 0.02; dx /= d; dy /= d;
      pos[a].x -= dx * f; pos[a].y -= dy * f; pos[b].x += dx * f; pos[b].y += dy * f;
    }
    for (let i = 0; i < nodes.length; i++) { pos[i].x += (W / 2 - pos[i].x) * 0.006; pos[i].y += (H / 2 - pos[i].y) * 0.006; }
  }
  // clamp into view
  for (const p of pos) { p.x = Math.max(24, Math.min(W - 24, p.x)); p.y = Math.max(24, Math.min(H - 24, p.y)); }
  return pos;
}

export default function KnowledgePanel({ region, onClose, onPick }) {
  const [graph, setGraph] = useState({ nodes: [], edges: [], method: 'heuristic' });
  const [articles, setArticles] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null); // selected node id

  useEffect(() => {
    getJson(`/api/graph?region=${region}`).then(setGraph).catch(() => {});
    Promise.all(['news', 'cafenews'].map((f) =>
      fetch(`/api/feeds/${f}?region=${region}`).then((r) => r.json()).then((j) => j.features || []).catch(() => [])
    )).then((lists) => setArticles(lists.flat().map((f) => f.properties)));
  }, [region]);

  const pos = useMemo(() => layout(graph.nodes, graph.edges), [graph]);
  const idx = useMemo(() => Object.fromEntries(graph.nodes.map((n, i) => [n.id, i])), [graph]);

  // Neighbours of the selected node (for highlight + news filter).
  const neighbours = useMemo(() => {
    if (!sel) return null;
    const set = new Set([sel]);
    const labels = new Set();
    for (const e of graph.edges) {
      if (e.from === sel) { set.add(e.to); labels.add(graph.nodes[idx[e.to]]?.label); }
      if (e.to === sel) { set.add(e.from); labels.add(graph.nodes[idx[e.from]]?.label); }
    }
    return { set, labels };
  }, [sel, graph, idx]);

  const filtered = articles
    .filter((a) => !q || (a.title || '').toLowerCase().includes(q.toLowerCase()))
    .filter((a) => {
      if (!sel) return true;
      const selNode = graph.nodes[idx[sel]];
      if (selNode?.type === 'NewsArticle') return a.title === selNode.label;
      // article links to the selected entity (its title is a neighbour NewsArticle)
      return neighbours?.labels?.has(a.title);
    });

  function clickNode(n) {
    setSel((s) => (s === n.id ? null : n.id));
    if (n.coord) onPick?.(n);
  }

  return (
    <div className="kg-overlay">
      <div className="kg-head">
        <span className="kg-title">KNOWLEDGE GRAPH <span className="muted">· {region} · {graph.nodes.length} entities · {graph.edges.length} links · {graph.method}</span></span>
        <button className="kg-close" onClick={onClose}>✕</button>
      </div>
      <div className="kg-body">
        <div className="kg-news">
          <input className="kg-search" placeholder="🔍 filter news…" value={q} onChange={(e) => setQ(e.target.value)} />
          {sel && <div className="kg-selnote">showing news for <b>{graph.nodes[idx[sel]]?.label}</b> <button onClick={() => setSel(null)}>clear</button></div>}
          <div className="kg-list">
            {filtered.length === 0 && <div className="muted" style={{ padding: 8 }}>No matching articles.</div>}
            {filtered.slice(0, 80).map((a, i) => (
              <a key={i} className="kg-art" href={a.url} target="_blank" rel="noopener">
                <div className="kg-art-title">{a.title}</div>
                <div className="kg-art-meta">{a.domain}{a.country ? ` · ${a.country}` : ''}</div>
              </a>
            ))}
          </div>
        </div>
        <div className="kg-graph">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
            {graph.edges.map((e, i) => {
              const a = pos[idx[e.from]], b = pos[idx[e.to]];
              if (!a || !b) return null;
              const hot = sel && (e.from === sel || e.to === sel);
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={hot ? '#fff' : '#3a4a60'} strokeOpacity={sel && !hot ? 0.15 : 0.6} strokeWidth={hot ? 1.6 : 1} />;
            })}
            {graph.nodes.map((n, i) => {
              const p = pos[i]; if (!p) return null;
              const dim = sel && !neighbours?.set.has(n.id);
              const r = Math.min(11, 4 + n.degree);
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: 'pointer', opacity: dim ? 0.25 : 1 }} onClick={() => clickNode(n)}>
                  <circle r={r} fill={TYPE_COLOR[n.type] || '#9ca3af'} stroke={sel === n.id ? '#fff' : '#0a0e14'} strokeWidth={sel === n.id ? 2 : 1} />
                  <text x={r + 3} y={3} fontSize="9" fill="#c9d6e5">{n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
