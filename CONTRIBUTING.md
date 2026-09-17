# Contributing to Philotas

Thanks for contributing. Philotas is an Apache-2.0 open-source project; the
fastest way to add value is to write a connector or fix a bug and ship it as a
pull request.

## The fastest on-ramp: write a connector

A data source is **one file**. The connector pattern lives in `lib/connectors/`:

- `lib/connectors/define.js` — `defineConnector(...)`, the source contract.
- `lib/connectors/registry.js` — the registry your connector registers into.
- `lib/connectors/sources/eonet.js` — a worked example (API connector).
- `lib/connectors/sources/facilities.js` — a worked example (datalake connector).

A connector is a `defineConnector(...)` call whose `pull()` returns GeoJSON:

```js
// SPDX-License-Identifier: Apache-2.0
import { defineConnector, apiPull } from '../define.js';
// use datalakePull({ query, toFeature }) instead for row stores

export const mySource = defineConnector({
  id: 'my-source',
  label: 'My Source',
  kind: 'api',                       // 'api' | 'datalake'
  ttl: 60_000,
  layer: { color: '#fb7185', type: 'circle', radius: 5 },
  pull: apiPull({
    url: () => 'https://example.com/feed.json',
    normalize: (data, region) => {
      // map the response into GeoJSON features; return an array
      const features = (data.items || []).map((it) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
        properties: { layer: 'my-source', title: it.name },
      }));
      return features;
    },
  }),
});
```

Register it in `lib/connectors/registry.js` and it flows into the cache, poller,
snapshot store, layer list, ontology and knowledge graph automatically. The MCP
server also exposes `scaffold_connector` and `validate_connector` to generate
and check a connector from the command line (see `mcp/README.md`).

## Building and testing

```bash
npm install          # install dependencies
npm run dev          # run the app (http://localhost:8788)
npm test             # root test suite
cd ingest && npm test   # ingest service tests
```

Write tests next to the code they cover under `test/` (or `ingest/test/` for the
ingest package). Tests use the Node built-in test runner (`node --test`) — no test
framework dependency.

## Coding conventions

- ESM throughout; keep the existing module layout.
- New public-destined modules start with `// SPDX-License-Identifier: Apache-2.0`.
- Prefer deterministic, explainable behaviour: detection and fallback paths should
  report which engine or resolver produced a result.
- Keep secrets out of the tree — read configuration from environment variables
  (documented in `.env.example`), never hardcode credentials or hostnames.
- Do not commit model weights (`*.pt`, `*.pth`, `*.onnx`) or runtime data
  (`.data/`).

## Licence

By contributing you agree your contribution is licensed under the Apache License,
Version 2.0 (see `LICENSE`). All commits must carry a Developer Certificate of
Origin sign-off:

```
Signed-off-by: Your Name <you@example.com>
```

Add it to your commit message with `git commit -s`. By adding the sign-off you
certify the statement in <https://developercertificate.org/>.

## Code of conduct

This project follows the Contributor Covenant — see `CODE_OF_CONDUCT.md`.
