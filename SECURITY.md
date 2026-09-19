# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in Philotas, please report
it privately rather than opening a public issue. Email
**security@philotas.com** with:

- a description of the issue and its impact,
- steps to reproduce, and
- any relevant logs or screenshots.

We will acknowledge your report within 5 business days and keep you informed as
we triage and fix it. Please do not disclose the issue publicly until we have
published a fix. We ask that you act in good faith and avoid data exfiltration,
service disruption or destruction of data while researching.

## Supported versions

We provide security fixes for the current stable release and the immediately
preceding release.

| Version | Supported |
|---|---|
| latest (main) | ✅ |
| previous release | ✅ |
| older releases | ❌ |

## Notes for operators

- The **basemap** is keyless **MapLibre GL** + CARTO/OpenStreetMap. No API key is
  required; self-host tiles for air-gapped deployments.
- **ultralytics** (YOLO) is an explicit **opt-in** detection engine (`DETECT_ENGINE=ultralytics`,
  AGPL-3.0). It is not loaded unless you select it; the default is a trained
  AutoGluon model via `AG_MODEL_DIR`.
- **OpenSky** is opt-in and bring-your-own-credentials (`OPENSKY_ENABLE=1` plus
  `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`); it is never enabled by default.
- Keep `ALLOW_INSECURE_COOKIE` **off** in production — it exists only for local
  HTTP development.
