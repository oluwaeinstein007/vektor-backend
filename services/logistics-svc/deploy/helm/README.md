# logistics-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match logistics-svc's actual runtime contract (port 3014, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for logistics-svc yet.
- DATABASE_URL/ROUTING_DATABASE_URL are expected from an operator-created Secret (`logistics-svc-db`), not embedded in this chart.
- ROUTING_DATABASE_URL points at a separate pgRouting-extension Postgres instance (pgRouting isn't installed on the main PostGIS image) - this chart doesn't provision that database, only expects its connection string.
- SVC-017's Debezium/Kafka Connect CDC pipeline (a third Postgres standing in for an ERP, plus a Kafka Connect worker) is entirely out of scope for this chart - it's a source-system integration this service consumes from, not something it deploys.
