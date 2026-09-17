# Third-party notices

Philotas is licensed under the Apache License, Version 2.0 (see `LICENSE`).
This file records the third-party dependencies and data sources it relies on,
with their licences. Versions are as installed; the authoritative versions live
in `package-lock.json`, `ingest/package-lock.json` and
`detect/requirements.txt`.

## Node.js (npm) dependencies — direct

Grouped by SPDX licence identifier.

### MIT

| Package | Version | Licence |
|---|---|---|
| fast-xml-parser | 4.5.6 | MIT |
| next | 16.2.9 | MIT |
| pg | 8.22.0 | MIT |
| react | 19.2.7 | MIT |
| react-dom | 19.2.7 | MIT |
| satellite.js | 5.0.0 | MIT |

### Apache-2.0

| Package | Version | Licence |
|---|---|---|
| gtfs-realtime-bindings | 1.1.1 | Apache-2.0 |

### BSD / ISC / other

None in the direct runtime set. The direct runtime dependencies above are all
MIT or Apache-2.0.

## Notable transitive dependencies

The `pg` and `gtfs-realtime-bindings` packages pull in further packages, each
distributed under its own licence:

| Package | Version | Licence |
|---|---|---|
| protobufjs | 7.6.4 | BSD-3-Clause |
| long | 5.3.2 | Apache-2.0 |
| pg-protocol | 1.15.0 | MIT |
| pg-types | 2.2.0 | MIT |
| postgres-array | 2.0.0 | MIT |

The `ingest/` package shares `pg` and `gtfs-realtime-bindings` with the root
application; its transitive set is covered by the same licences above. Dev-only
tooling (linters, documentation generators) is not distributed and remains under
its own licences inside `node_modules`.

## Python dependencies (`detect/`)

| Package | Licence |
|---|---|
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| httpx | BSD-3-Clause |
| pillow | MIT-CMU |
| python-multipart | Apache-2.0 |
| numpy | BSD-3-Clause |
| opencv-python-headless | Apache-2.0 |
| pandas | BSD-3-Clause |

Optional detection engines, installed only when you choose them:

| Package | Licence |
|---|---|
| autogluon | Apache-2.0 |
| ultralytics | AGPL-3.0 |

ultralytics (YOLO) is an explicit opt-in under `DETECT_ENGINE=ultralytics` and
is not loaded by default.

## Data-provider attributions

This software displays data retrieved at runtime from third-party sources, owned
by their respective providers — including OpenSky Network, the adsb.fi community
network, CelesTrak, Transport Canberra, NSW Rural Fire Service, the U.S.
Geological Survey, Geoscience Australia, the Australian Bureau of Meteorology,
The GDELT Project, NASA JPL (Deep Space Network) and NASA EONET.

The OpenSky Network's terms restrict its data to non-profit research and
education; a live operational deployment requires a written licence from
OpenSky. This software treats OpenSky as an opt-in, bring-your-own-credentials
source and never enables it by default.

Fire hotspot detections are courtesy of NASA's Land, Atmosphere Near real-time
Capability for EOS (LANCE, https://earthdata.nasa.gov/lance), part of NASA's
Earth Observing System Data and Information System (EOSDIS). NASA does not
endorse this product.

Base map tiles © CARTO and © OpenStreetMap contributors. The optional Google
Maps basemap requires your own `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`; no Google
Maps credentials ship with this project, and Google Maps imagery is subject to
Google's own terms.

Review each provider's terms before relying on their data.

---

This project incorporates no code from third-party intelligence-platform
projects; every dependency is listed above.
