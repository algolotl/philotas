# Philotas

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![CI](https://github.com/algolotl/philotas/actions/workflows/ci.yml/badge.svg)](https://github.com/algolotl/philotas/actions/workflows/ci.yml)

A real-time geospatial **common operating picture**: many live data sources fused
onto one map, connected into a single picture by an **AI-driven ontology**, with a
knowledge-graph view, time-replay, alerting, operational actions, team workspaces,
and role/classification-based access control.

**Philotas is open source.** The core ships under the Apache-2.0 licence — clone it,
run it locally, and integrate it through its MCP server. Enterprises buy a **support
licence** for hardened deployments, licensed data feeds and SLA-backed support (see
[Licence](#licence)).

Stack: Next.js 16 (App Router, Turbopack), MapLibre GL (keyless CARTO basemap),
Node
runtime, file store or Postgres, LLM adjudication through the `lib/llm.js` provider
adapter (an OpenAI-compatible HTTP endpoint, or the optional internal client, with a
deterministic heuristic fallback), and object detection via a companion Python
service (AutoGluon by default, ultralytics opt-in — see `detect/`).

---

## Quickstart

```bash
git clone https://github.com/algolotl/philotas.git
cd philotas
npm install
npm run dev          # http://localhost:8788
```

Node ≥ 18.17 and a WebGL-capable browser. No keys are required for the core layers:
the datastore defaults to a local JSON file and the transport, seismic, weather and
news layers run keyless. Register the first account to become admin.

For production, `npm run build && npm start`.

### Docker Compose

```bash
docker compose up -d                       # app + Postgres
docker compose --profile detect up -d      # + the object-detection service
```

The app serves on http://localhost:8788. See `docker-compose.yml` for the service
definitions.

### MCP server

A Model Context Protocol server lives in `mcp/` — read-only access to a running
deployment (status, regions, feeds, graph, search, alerts, detections) plus
developer scaffolding (`scaffold_connector`, `validate_connector`, `run_tests`).
See `mcp/README.md` for install, configuration and client setup.

---

## What it does

- **Unified live map** — a keyless MapLibre GL globe (no Google Maps, no API key),
  region switcher, deep-linkable views (`?region=&lng=&lat=&zoom=`).
- **Maritime and transport convergence** — vessels alongside Transport for NSW
  ferries, trains, buses, light rail and metro, against a register of Sydney
  berths and terminals. Circular Quay is where the two domains physically meet.
  Live ferry positions come from Transport for NSW; commercial shipping arrives
  through the one-file connector model (port-movement schedules plug in as a
  connector; licensed feeds are available through a support licence). Port rows
  carry a berth rather than a coordinate, so those vessels are placed at their
  berth and marked as inferred rather than observed.
- **Data layers** via a one-file connector model (API *or* datalake): vessels,
  transport, berths, aviation (keyless adsb.fi; OpenSky opt-in with your own
  credentials), satellites overhead, CCTV, fire/emergency, seismic, weather,
  news, deep-space tracking, natural events and facilities.
- **Deterministic anomaly detection** — transmission gaps, loitering and sustained
  course deviation, each measured against a vessel's own observed cadence rather
  than a global threshold, because a ferry reporting every 30s and an anchored
  carrier reporting every 120s cannot share one. Every event carries the
  arithmetic that produced it. No model participates in detection.
- **Object detection (VISION)** — run a detector over any live camera still on the
  map, a video feed URL or an uploaded image; boxes draw over the picture and
  detections plot at their map location. Select a detection and *find other
  instances of it* across the region's cameras. Detection defaults to a trained
  AutoGluon model (`AG_MODEL_DIR`); ultralytics YOLO is an explicit opt-in. See
  `detect/README.md`.
- **Detection workflows** — when detections match a workflow's trigger (classes,
  minimum score, count within a window, e.g. *an accident at a traffic light*),
  the engine raises an alert, attaches the workflow, and fires its actions
  (webhook notify, operator action row) with a cooldown. Built-in
  *Traffic light accident watch* ships enabled; operators add their own.
- **AI ontology** — resolves cross-source links (a vessel is *berthed at* a
  terminal; a ground station *tracks* a spacecraft; a headline *mentions* a
  specific ship or quake), each with confidence, provenance and method. Ambiguous
  links are adjudicated by a local model through the `lib/llm.js` adapter (an
  OpenAI-compatible HTTP endpoint, or the optional internal client); a
  deterministic resolver runs when no model is configured, and the interface
  shows which one ran.
- **Knowledge graph + news** — an entity graph (nodes = entities, edges = resolved
  relationships) beside a searchable news list. Select an entity → its connections
  and its news; select an aircraft → its flights and airline coverage.
- **Time replay** — scrub/play recorded snapshots to reconstruct how a situation
  unfolded (and decouple clients from rate-limited upstreams).
- **Search + link-exploration**, **alerting + rules** (with map alert rings),
  **actions / write-back** (flag / task / dispatch / watch, audit-logged, optional
  webhook to external systems).
- **Workspaces** — annotate and save the view; stored centrally (Postgres) and
  shared by **allocating named users**.
- **Access control** — roles (viewer / operator / admin), classification labels
  with clearance-gated visibility, and a full audit trail. First registered user is
  the admin.

---

## Regions (city / country / region views)

Regions are data, so re-aiming the whole picture is config. A `place()` factory
builds any location from the globally-capable sources, so adding one needs no
bespoke feed wiring. Shipped:

- **Worldwide** — the global view (air, orbit, seismic, news by source country).
- **Cities** — Canberra · AU, Sydney · AU, Melbourne · AU, San Francisco · US,
  Washington DC · US, London · GB, Tel Aviv · IL. (Country code disambiguates
  same-named cities.)
- **Countries** — Australia, United States.
- **Regions** — South Pacific (multi-country).

The switcher groups by type. **Sydney is the flagship build** (vessels, berths,
five transport modes, aviation, orbit, emergency, weather, news) and the default
landing region. Canberra retains the NASA Deep Space Network, which supplies the
ontology's only *structural* links — ground station tracks spacecraft, spacecraft
matches a tracked satellite — resolved without any model. Other cities use the
reusable global sources.

---

## Architecture

```
app/        Next.js App Router — UI + API route handlers
components/  MapView (MapLibre GL), KnowledgePanel (graph + news)
ingest/      standalone AIS ingest service + deterministic detectors (own package)
mcp/         Model Context Protocol server (read-only tools + developer scaffolding)
detect/      Python object-detection service (FastAPI)
lib/
  regions.js     regions = data (type, home, bbox, observer, sites, arc)
  cache.js       background poller + per-(source,region) cache
  store.js       rolling snapshot store (time replay)
  feeds/         core source normalizers -> uniform GeoJSON
  connectors/    the connector pattern (api + datalake) + registry
  ontology/      induce + resolve cross-source links (adjudicated via lib/llm.js)
  corpus/        news + retrieval, hypothesis governance
  llm.js         LLM provider adapter (HTTP OpenAI-compatible / internal / heuristic)
  rules.js       alerting rule engine
  db.js          datastore: Postgres (DATABASE_URL) or local JSON file
  auth.js        scrypt auth, sessions, roles + clearance
  guard.js       route guard — every read route requires a session
```

**Ingest is a separate package.** AIS arrives over a websocket, and a websocket
has to outlive a request, so `ingest/` holds the socket, maintains vessel state,
runs the detectors and writes to Postgres. The application only reads. If ingest
dies the map keeps working on last-known state with a staleness marker.

```bash
cd ingest && npm test     # no external dependencies required
```

**Add a data source in one file**: `defineConnector` with a `pull()` returning
GeoJSON — `apiPull` (fetch a URL) or `datalakePull` (query rows; swap for
Databricks / Snowflake / DuckDB). It then flows into the cache, poller, snapshot
store, layer list, ontology and knowledge graph automatically. See
`CONTRIBUTING.md`.

The full file map is in `ARCHITECTURE.md` and `docs/public-architecture.md`.

---

## Environment variables

Copy `.env.example` to `.env.local` to enable the keyed extensions below. The
app runs fully without any of them.

### Basemap

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_MAP_STYLE_URL` | CARTO dark-matter style | Basemap style URL. The map is keyless MapLibre GL — no Google Maps, no API key. Point it at a self-hosted tile/style server for air-gapped deployments. |

Connected deployments use the keyless CARTO/OpenStreetMap basemap by default;
air-gapped deployments serve self-hosted offline tiles.

### Datastore

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | unset | Postgres connection string. Unset uses a local JSON file under `.data/`. Set it for a real, multi-replica datastore. |

### Transport, CCTV and fire hotspots

| Variable | Default | Purpose |
|---|---|---|
| `TFNSW_API_KEY` | unset | Transport for NSW Open Data token — one token covers the five realtime transport modes, traffic cameras and ferry positions. Without it those layers report empty and say why. |
| `ACT_LIGHTRAIL_URL` | `https://files.transport.act.gov.au/feeds/lightrail.pb` | Canberra light-rail GTFS-Realtime endpoint override. |
| `CCTV_GEOJSON_URL` | unset | Live camera GeoJSON feed (e.g. Transport for NSW). Without it the CCTV layer serves camera sites only. |
| `CCTV_AUTH` | unset | A single `"Header-Name: value"` pair sent with the CCTV feed request. |
| `FIRMS_MAP_KEY` | unset | NASA FIRMS map key for fire-hotspot detections. Without it the hotspots layer is empty and labelled. |

### Aviation (OpenSky)

| Variable | Default | Purpose |
|---|---|---|
| `OPENSKY_CLIENT_ID` | unset | OpenSky OAuth2 client id — bring your own credentials (non-commercial terms apply). |
| `OPENSKY_CLIENT_SECRET` | unset | OpenSky OAuth2 client secret. |
| `OPENSKY_USER` / `OPENSKY_PASS` | unset | Legacy OpenSky basic-auth fallback. |
| `OPENSKY_ENABLE` | unset | Opt-in gate. OpenSky is used only when this is `1` *and* credentials are present; otherwise the keyless adsb.fi source is used. |

### Object detection (`detect/` service)

| Variable | Default | Purpose |
|---|---|---|
| `DETECTION_URL` | `http://127.0.0.1:8770` | Address of the Python detection service. |
| `AG_MODEL_DIR` | unset | Trained AutoGluon ObjectDetector directory (the default, supported engine). |
| `DETECT_ENGINE` | `auto` | Engine selector: `auto`, `autogluon`, or `ultralytics`. |
| `YOLO_MODEL` | `yolo11n.pt` | ultralytics model (honoured only under `DETECT_ENGINE=ultralytics`, which is opt-in). |
| `DETECT_CONF` | `0.25` | Detection confidence threshold. |
| `VIDEO_SAMPLE_EVERY` | `25` | Sample one video frame every N. |
| `VIDEO_MAX_FRAMES` | `40` | Frames sampled per video call. |
| `DETECTION_PORT` | `8770` | Port the detect service binds. |

### LLM adjudication

| Variable | Default | Purpose |
|---|---|---|
| `PHILOTAS_LLM_URL` | unset | Base URL of an OpenAI-compatible HTTP endpoint (chat / embeddings / rerank), e.g. `http://localhost:8000/v1`. Enables model adjudication through `lib/llm.js`. |
| `OPENAI_COMPATIBLE_ENDPOINT` | unset | Alias for `PHILOTAS_LLM_URL` — either enables the HTTP provider. |
| `ONTOLOGY_LLM` | unset | Set `off` to force the deterministic heuristic resolver (skip the model). |

### Webhooks

| Variable | Default | Purpose |
|---|---|---|
| `WORKFLOW_WEBHOOK_URL` | unset | Webhook target for detection-workflow `webhook` actions. |
| `ACTIONS_WEBHOOK_URL` | unset | Webhook target for operator actions / write-back. |

### Auth and access

| Variable | Default | Purpose |
|---|---|---|
| `PHILOTAS_TRIAL` | unset | Set `1` to enable a read-only viewer session at `POST /api/auth/guest` for a public demonstrator. |
| `ALLOW_INSECURE_COOKIE` | unset | Set `1` to allow the session cookie without the `Secure` flag. **Default off** — only enable for local HTTP development, never behind HTTPS or in production. |
| `PHILOTAS_OPEN_READ` | unset | Set `1` to drop the read gate (read routes become unauthenticated). |
| `PHILOTAS_WARM_REGIONS` | `sydney` | Comma-separated regions pre-polled at boot. |

### Ingest service (`ingest/`, separate package)

| Variable | Default | Purpose |
|---|---|---|
| `AIS_REGION` | `sydney` | Region id recorded on AIS ingest events. |
| `DATABASE_URL` | unset | Postgres connection string for ingest output (shared with the app). |
| `TFNSW_API_KEY` | unset | Transport for NSW token for ferry positions (required by ingest). |

---

## Seeded demo

`npm run demo:seed` populates the VISION panel, the map's detection markers and
the ALERTS panel with the worked example — real detection output over a
traffic-light intersection and two traffic-jam photos, run through the real
workflow engine (both the built-in *Traffic light accident watch* and the George St
/ Park St workflow fire). Rows are tagged *demo* in the UI and cleared/re-seeded on
each run; alert rows decay after 30 minutes (the engine's own alert window), so
re-run the seed to refresh the example.

## Trial access

`PHILOTAS_TRIAL=1` enables a viewer-role session at `POST /api/auth/guest` for a
public demonstrator. Read-only: no write-back, no rule changes, no administration.
Leave it unset for a private deployment.

---

## Contributing

Connector-authoring is the fastest way to contribute — a data source is one file
with a `pull()` that returns GeoJSON. See `CONTRIBUTING.md` for the on-ramp,
test commands, coding conventions and the DCO sign-off.

## Security

Found a vulnerability? See `SECURITY.md` for the disclosure policy and supported
versions. Note that the ultralytics engine is opt-in.

## Licence

Licensed under the **Apache License, Version 2.0** — see `LICENSE`. Copyright ©
2026 Kovacorp Pty Ltd.

Support licences (SLA-backed support, enterprise add-ons, licensed data feeds,
air-gapped deployment) are sold separately at <https://philotas.com>. The open
source grant covers the code; it does not include those commercial offerings.

Third-party data shown at runtime is © its providers — see `NOTICE` and
`THIRD-PARTY-NOTICES.md`. Review each provider's terms before any operational use.
