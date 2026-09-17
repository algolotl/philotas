// SPDX-License-Identifier: Apache-2.0
import http from 'node:http';

// Minimal in-process stub of the Philotas API for tests. Serves canned payloads
// for the read-only endpoints the MCP tools call, echoing query params so tests
// can assert the handlers forwarded them correctly.
export function startStubApi({ statusCode = 200 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (url.pathname === '/api/status') {
        if (statusCode !== 200) return send(statusCode, { error: 'status failed' });
        return send(200, {
          region: 'sydney',
          feeds: { aviation: { count: 4, error: null, stale: false, live: true } },
          schema: { status: 'ok', reason: null },
        });
      }
      if (url.pathname === '/api/regions') {
        return send(200, { regions: [{ id: 'sydney', label: 'Sydney' }, { id: 'world', label: 'World' }] });
      }
      if (url.pathname.startsWith('/api/feeds/')) {
        const feed = decodeURIComponent(url.pathname.split('/').pop());
        return send(200, {
          feed,
          label: 'Label for ' + feed,
          region: url.searchParams.get('region') || null,
          count: 1,
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [151.2, -33.9] }, properties: { title: 'x' } }],
        });
      }
      if (url.pathname === '/api/graph') {
        return send(200, {
          region: url.searchParams.get('region') || 'sydney',
          method: 'heuristic',
          nodes: [{ id: 'n1', label: 'a', type: 'vessel' }],
          edges: [],
        });
      }
      if (url.pathname === '/api/search') {
        return send(200, { q: url.searchParams.get('q'), region: url.searchParams.get('region') || null, total: 0, results: [] });
      }
      if (url.pathname === '/api/alerts') {
        return send(200, { region: url.searchParams.get('region') || 'sydney', count: 0, alerts: [] });
      }
      if (url.pathname === '/api/detections') {
        return send(200, { region: url.searchParams.get('region') || null, count: 0, detections: [] });
      }
      return send(404, { error: 'not found' });
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: 'http://127.0.0.1:' + port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
