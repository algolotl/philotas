# Philotas — public architecture

A curated, public-facing overview of how Philotas is put together. For the
complete per-file map, see `ARCHITECTURE.md`.

Philotas is a real-time geospatial **common operating picture**: many live data
sources fused onto one map, connected by an **AI-driven ontology**, with a
knowledge graph, time-replay, alerting, operational actions, workspaces and
role/classification-based access control. It ships as Apache-2.0 open source.

---

## Components

| Component | Stack | Role |
|---|---|---|
| **Web app** | Next.js 16 (App Router, Turbopack) | The map UI + API route handlers. Serves on 8788. |
| **Ingest service** | Node (separate package, `ingest/`) | AIS arrives over a websocket that must outlive a request; `ingest/` holds the socket, maintains vessel state, runs the deterministic detectors and writes to Postgres. The app only reads. |
| **Detection service** | Python 3.13, FastAPI (`detect/`) | Object detection + image similarity behind a small HTTP API. |
| **MCP server** | Node, `mcp/` | Read-only Model Context Protocol access to a running deployment, plus developer scaffolding. |
| **Datastore** | Postgres or a local JSON file | Users, sessions, workspaces, rules, workflows, audit. |

## Request flow

```
browser ──▶ app/page.jsx ──▶ /api/context, /api/feeds/*, /api/graph, /api/alerts
                                  │
   lib/regions.js (which region) ─┤
   lib/feeds/* (live source pull) ─┤──▶ lib/cache.js (TTL + background poll)
   lib/connectors/* (datalake/api) ┤        │
   lib/ontology/* (resolve+link) ──┘        └▶ lib/store.js (rolling snapshots → time-replay)
                                  │
   lib/db.js / lib/auth.js (state, users, workspaces, audit)
```

## Key subsystems

### The ontology and the LLM adapter

Cross-source links (a vessel is *berthed at* a terminal, a headline *mentions* a
ship) are induced and resolved with confidence, provenance and method. Ambiguous
links are adjudicated through **`lib/llm.js`**, a provider adapter that resolves,
in order:

1. an **OpenAI-compatible HTTP endpoint** — `PHILOTAS_LLM_URL` /
   `OPENAI_COMPATIBLE_ENDPOINT` (chat / embeddings / rerank), e.g.
   `http://localhost:8000/v1`;
2. the **optional internal client**, if installed; and
3. a **deterministic heuristic** fallback.

The interface always shows which resolver ran. No model participates in anomaly
detection — the transmission-gap, loitering and course-deviation detectors are
fully deterministic.

### Detection engines

Object detection defaults to **AutoGluon** (Apache-2.0): point `AG_MODEL_DIR` at
a trained `ObjectDetector` directory. **ultralytics** YOLO is an explicit,
AGPL-3.0 opt-in — it loads only when `DETECT_ENGINE=ultralytics` is selected, and
only then is `YOLO_MODEL` honoured. No model weights are committed; you bring
your own.

### Aviation feeds

The keyless **adsb.fi** network is the default. **OpenSky** is opt-in and
bring-your-own-credentials: it is used only when `OPENSKY_CLIENT_ID` /
`OPENSKY_CLIENT_SECRET` are present **and** `OPENSKY_ENABLE=1`. OpenSky's terms
restrict its data to non-commercial research and education; a live operational
deployment requires a written licence from OpenSky.

### Connectors

A data source is **one file**: `defineConnector` with a `pull()` returning
GeoJSON — `apiPull` (fetch a URL) or `datalakePull` (query rows; swap for
Databricks / Snowflake / DuckDB). The connector then flows into the cache, poller,
snapshot store, layer list, ontology and knowledge graph automatically. See
`CONTRIBUTING.md`.

### Data flow and caching

`lib/cache.js` polls each `(source, region)` pair on its own TTL and feeds
`lib/store.js`, a rolling snapshot store that powers time-replay and decouples
clients from rate-limited upstreams.

---

## Deployment topology

```
        ┌──────────────┐     ┌──────────────┐
        │   web app    │ ──▶ │   Postgres   │
        │   :8788      │     │   :5432      │
        └──────┬───────┘     └──────────────┘
               │ DETECTION_URL
        ┌──────▼───────┐
        │   detect/    │     (optional `detect` compose profile)
        │   :8770      │
        └──────────────┘
```

- **Web app** — `docker compose up -d` builds and serves the app with Postgres.
- **Detection** — `docker compose --profile detect up -d` adds the FastAPI
  service; it needs a trained AutoGluon model (mounted at `AG_MODEL_DIR`) or an
  explicit ultralytics opt-in.
- **Ingest** — runs as its own process/package and writes to the same Postgres.

The full environment reference is in `README.md` and `.env.example`.

---

## File map (condensed)

```
app/        Next.js App Router — UI + API route handlers
components/  MapView (Google Maps), KnowledgePanel (graph + news)
ingest/      standalone AIS ingest service + deterministic detectors (own package)
mcp/         Model Context Protocol server (read-only tools + developer scaffolding)
detect/      Python object-detection service (FastAPI)
lib/
  llm.js       LLM provider adapter (HTTP OpenAI-compatible / internal / heuristic)
  feeds/       core source normalizers -> uniform GeoJSON
  connectors/  the connector pattern (api + datalake) + registry
  ontology/    induce + resolve cross-source links (adjudicated via lib/llm.js)
  corpus/      news + retrieval, hypothesis governance
  cache.js     background poller + per-(source,region) cache
  store.js     rolling snapshot store (time replay)
  db.js        datastore: Postgres (DATABASE_URL) or local JSON file
  auth.js      scrypt auth, sessions, roles + clearance
  guard.js     route guard — every read route requires a session
```

For the complete list, see `ARCHITECTURE.md`.
