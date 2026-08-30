# edge-sync-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match edge-sync-svc's actual runtime contract (port 3012, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for edge-sync-svc yet.
- This service is meant for an edge node, not the main vektor-backend cluster namespace this chart's sibling ArgoCD ApplicationSet targets - deploying it there only makes sense for the edge-profile Deployment referenced in vektor-edge's compose/docker-compose.edge.yml, not the cloud ApplicationSet.
- EDGE_SYNC_DB_PATH (better-sqlite3, the persisted Kafka-offset store) needs a PersistentVolume at that path or every pod restart loses delta-sync position - not provisioned by this chart.
- VEKTOR_EDGE_NODE_ID must be unique per physical edge node (two Jetsons sharing one Kafka consumer group id would split partitions incorrectly) - the placeholder here is deliberately not a usable default.
