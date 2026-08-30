# ingest-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/ServiceAccount match ingest-svc's actual runtime contract the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for ingest-svc yet.
- This service runs multiple independent adapters (RTSP/GeoTIFF/AIS/ADS-B/MQTT) from one process, each gated by its own env vars being set — most values above are placeholders an operator must fill in per real sensor, not real defaults.
- GEOTIFF_INBOX_DIR is a filesystem watch directory — a real deployment needs a PersistentVolume mounted there, not left as ephemeral pod storage.
