# Philotas — architecture & file map

A live, multi-source geospatial common operating picture. Next.js (App Router)
+ MapLibre GL on the front (keyless CARTO/OpenStreetMap basemap), a connector/
feed layer pulling live sources, an AI-built ontology
that resolves entities and links across those sources, an object-detection
pipeline (VISION panel + Python service) with detection workflows that raise
alerts, and a backend with auth, workspaces, rules/alerts, actions and an
audit trail.

This document is the index: every tracked file with a one-line purpose. Each
source file also opens with its own header comment — this is the map, those are
the detail.

---

## Request flow (how a frame is built)

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

LLM adjudication is reached through `lib/llm.js`, which resolves a provider in
order: an OpenAI-compatible HTTP endpoint (`PHILOTAS_LLM_URL` /
`OPENAI_COMPATIBLE_ENDPOINT`), the optional internal client, then a
deterministic heuristic fallback.

---

## Top level

| File | Purpose |
|---|---|
| `package.json` | Project manifest + scripts (`dev`, `build`, `start`, `test`, `demo:seed`). |
| `package-lock.json` | Exact dependency lockfile — `npm install` reproduces `node_modules` from this. |
| `next.config.mjs` | Next.js build config. |
| `jsconfig.json` | Path aliases (`@/…`) for imports. |
| `Dockerfile` / `.dockerignore` | Container build for the app (runs on 8788; persists `/app/.data`). |
| `docker-compose.yml` | Compose stack: app + Postgres, with an optional `detect` profile. |
| `.env.example` | Documented environment variables (datastore, OpenSky, detection, LLM, auth). |
| `.gitignore` / `.gitattributes` | Excludes `node_modules/`, `.next/`, `.data/`, model weights (build/deps/runtime — all reproducible). |
| `README.md` | Product overview, quickstart, environment reference. |
| `NOTICE` | Third-party data attributions. |
| `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` | Contribution, disclosure and conduct policies. |
| `THIRD-PARTY-NOTICES.md` | Dependency licence notices. |
| `ARCHITECTURE.md` | This file. |

## `app/` — routes & UI shell

| File | Purpose |
|---|---|
| `app/page.jsx` | The map application: capabilities tiles, region select, layers, vision + workflows panels, alerts, replay, knowledge graph. |
| `app/layout.jsx` | Root layout; loads global CSS. |
| `app/globals.css` | App styling, including the pinned mini-graph and knowledge-panel overlay. |

## `app/api/` — backend endpoints

| File | Purpose |
|---|---|
| `api/context/route.js` | Map setup (centre, zoom, layers) for a region. |
| `api/regions/route.js` | List of selectable regions (world / country / region / city). |
| `api/feeds/[feed]/route.js` | Normalized GeoJSON for one feed in a region. |
| `api/history/[feed]/route.js` | Recent recorded frames for a feed — powers time-replay. |
| `api/status/route.js` | Compact per-feed health for the header strip. |
| `api/alerts/route.js` | Entities currently matching active rules. |
| `api/rules/route.js` | Built-in + user-defined alerting rules (CRUD). |
| `api/actions/route.js` | Operator actions / write-back, recorded to the audit trail. |
| `api/graph/route.js` | The region's entities and relationships, for the knowledge graph. |
| `api/ontology/route.js` | Induced object model + resolved links (with adjudication rationale). |
| `api/search/route.js` | Full-text search + link exploration across the corpus. |
| `api/corpus/search/route.js` | Retrieval over the news corpus. |
| `api/casefiles/route.js` / `api/casefiles/[id]/route.js` | Case-file CRUD. |
| `api/intel/route.js` | Intel summaries. |
| `api/workspaces/route.js` | My workspaces + ones shared to me (classification-gated). |
| `api/workspaces/[id]/route.js` | A single workspace (read/update if owned or shared). |
| `api/users/route.js` | User listing + role assignment (admin only). |
| `api/audit/route.js` | The audit trail (admin only). |
| `api/auth/{login,logout,register,me,guest}/route.js` | Password auth, sessions, current-user (role + clearance), guest viewer. |

## `components/`

| File | Purpose |
|---|---|
| `components/MapView.jsx` | MapLibre GL map; renders all layers as GeoJSON sources + markers, handles camera moves on a 3D globe. |
| `components/KnowledgePanel.jsx` | Full-screen searchable news list + force-directed entity graph. |
| `components/MiniGraph.jsx` | Always-on mini knowledge graph pinned to the map corner. |

## `lib/feeds/` — live data sources

| File | Purpose |
|---|---|
| `feeds/aviation.js` | Live aircraft — keyless adsb.fi by default; OpenSky only when `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` are set **and** `OPENSKY_ENABLE=1` (opt-in, non-commercial terms). |
| `feeds/satellites.js` | Orbital layer, region-aware. |
| `feeds/seismic.js` | Recent earthquakes from the USGS day-feed (keyless). |
| `feeds/fires.js` | NSW RFS major fire & emergency incidents. |
| `feeds/hotspots.js` | NASA FIRMS fire-hotspot detections (`FIRMS_MAP_KEY`). |
| `feeds/weather.js` | Bureau of Meteorology observations (keyless), region-aware. |
| `feeds/news.js` | GDELT recent coverage, region-aware. |
| `feeds/gdelt-gkg.js` / `feeds/gdelt-unzip.js` | GDELT GKG retrieval + decompression helpers. |
| `feeds/space.js` | NASA Deep Space Network "DSN Now" (Canberra complex). |
| `feeds/transport.js` | Transport for NSW realtime vehicle positions (Sydney) + Canberra light rail. |
| `feeds/vessels.js` | Vessel layer (ferry positions via `TFNSW_API_KEY`). |
| `feeds/cameras.js` | Traffic cameras (sites by default; live imagery with `CCTV_GEOJSON_URL`). |

## `lib/connectors/` — the source-plugin pattern

| File | Purpose |
|---|---|
| `connectors/define.js` | `defineConnector` — the API/datalake source contract. |
| `connectors/registry.js` | Registry; add a source by writing one connector file. |
| `connectors/sources/eonet.js` | Example API connector — NASA EONET natural-event tracker. |
| `connectors/sources/facilities.js` | Example datalake connector — facilities from a "lake". |

## `lib/ontology/` — the AI-built model

| File | Purpose |
|---|---|
| `ontology/build.js` | The AI-driven ontology pass: induce object types, resolve cross-source links. |
| `ontology/candidates.js` | Candidate link/entity generation. |
| `ontology/llm.js` | Adjudication call site (invokes `lib/llm.js`; `ONTOLOGY_LLM=off` forces the heuristic). |
| `ontology/profiles.js` | Entity/class profiles used for matching. |
| `ontology/score.js` | Confidence scoring for resolved links. |
| `ontology/service.js` | Cached ontology accessor shared by `/api/ontology` and `/api/search`. |

## `lib/corpus/` and `lib/casefiles/` — news, retrieval and case work

| File | Purpose |
|---|---|
| `corpus/store.js` / `corpus/news-store.js` | News storage + indexes. |
| `corpus/retrieve.js` / `corpus/search.js` | Retrieval and search over the corpus. |
| `corpus/connections.js` | Entity↔news link resolution. |
| `corpus/hypothesis.js` / `corpus/governor.js` | Hypothesis generation + governance (model-reviewed, heuristic fallback). |
| `corpus/scope.js` / `corpus/limit.js` / `corpus/chunk.js` | Scope gating, limits and chunking. |
| `corpus/sources/{index,gdelt,amsa,nswhealth}.js` | Corpus source normalizers. |
| `casefiles/service.js` / `casefiles/assess.js` | Case-file persistence + assessment. |

## `lib/` — core services & data

| File | Purpose |
|---|---|
| `lib/llm.js` | LLM provider adapter (HTTP OpenAI-compatible / optional internal client / heuristic). |
| `lib/embed.js` / `lib/rerank.js` | Embeddings + reranking, through the `lib/llm.js` adapter. |
| `lib/regions.js` | Region factory + catalogue (world, countries, regions, cities). |
| `lib/region-catalogue.js` / `lib/region-groups.js` | Region catalogue helpers + switcher grouping. |
| `lib/config.js` | Geo-anchors, bounding boxes, per-feed cache TTLs. |
| `lib/layers.js` | Client-safe layer descriptors: draw order, colour, label, render style. |
| `lib/cache.js` | Feed cache + background poller + snapshot recorder. |
| `lib/store.js` / `lib/frames.js` | Rolling snapshot store keyed by `feed:region` — powers replay. |
| `lib/rules.js` | Default + user rules engine (quakes, emergency squawks, fires). |
| `lib/workflows.js` | Detection workflows: object detections → alerts → webhook/action steps. |
| `lib/detection.js` | Server-side client for the Python detection service (`DETECTION_URL`). |
| `lib/db.js` | Repository over two backends: Postgres (`DATABASE_URL`) or file (`.data/`). |
| `lib/auth.js` | Password auth, sessions, roles (viewer/operator/admin) + clearance levels. |
| `lib/guard.js` | Route guard — every read route requires a session (`PHILOTAS_OPEN_READ` opt-out). |
| `lib/audit.js` / `lib/trail-key.js` | Audit-trail helper + keying. |
| `lib/teams.js` | Team/workspace sharing. |
| `lib/geo.js` / `lib/projection.js` | Geospatial + projection helpers. |
| `lib/fetch-json.js` / `lib/http.js` / `lib/errors.js` | Fetch/HTTP helpers + shared error types. |
| `lib/feed-health.js` / `lib/tfnsw-limit.js` / `lib/adsb-coverage.js` | Feed health, TfNSW quota handling, adsb.fi coverage. |
| `lib/payload-version.js` | Payload versioning. |
| `lib/trial-chooser.js` | Guest/trial session selection. |
| `lib/data/country-centroids.js` | Approximate country centroids `[lon, lat]` by name. |
| `lib/data/region-probe.js` | Region probe data. |
| `lib/data/sample-lake/*.json` | Committed sample datalake content for the connectors. |

## `scripts/`

| File | Purpose |
|---|---|
| `scripts/seed-demo.mjs` | `npm run demo:seed` — seeds the detection demo (real captured detections, real engine firings, tagged `demo` in the UI). |

## `detect/` — the object-detection service (Python)

| File | Purpose |
|---|---|
| `detect/service.py` | FastAPI service: `/health`, `/detect`, `/detect_video`, `/similar`. AutoGluon ObjectDetector is the default when `AG_MODEL_DIR` is set; ultralytics YOLO is an explicit opt-in (`DETECT_ENGINE=ultralytics` + `YOLO_MODEL`). Reports degradation clearly either way. |
| `detect/train.py` | Trains an AutoGluon object detector from COCO-format annotations. |
| `detect/requirements.txt` / `README.md` / `Dockerfile` | Install, run and container instructions. |

## Vision / workflow API routes (see also the app/api/ table)

| File | Purpose |
|---|---|
| `api/detection/health/route.js` | Detection service health (engine, model, classes). |
| `api/detection/detect/route.js` | Detect on one image (URL/data URL); stores rows, runs workflows. |
| `api/detection/scan/route.js` | Sweep every live camera still in a region through the detector. |
| `api/detection/video/route.js` | Sample a video feed URL and record detections. |
| `api/detection/similar/route.js` | "Find other instances of this" across candidate images. |
| `api/detections/route.js` | Recent stored detections for a region. |
| `api/workflows/route.js` | Detection-workflow CRUD (list/create/toggle/delete). |

## `docs/`

| File | Purpose |
|---|---|
| `docs/public-architecture.md` | Curated public architecture overview. |
| `docs/llm-ontology-example.md` | Worked example: how the ontology pass reasons about a link. |

---

## What's deliberately *not* in git

`node_modules/` (deps — rebuilt by `npm install`), `.next/` (build output —
rebuilt by `npm run build`), and `.data/` (runtime database the app writes while
running). Model weights (`*.pt`, `*.pth`, `*.onnx`) are also excluded — you
bring your own trained model. All of these are reproducible or provided by you;
only source lives in the repo.
