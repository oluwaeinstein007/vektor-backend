# map-tile-server Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match map-tile-server's actual runtime contract (port 3008, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for map-tile-server yet.
- TILES_DIR is a bare in-container path - a real deployment needs a PersistentVolumeClaim mounted there (or an initContainer that pulls EDGE-004 map packs from object storage), neither of which this chart provisions.
