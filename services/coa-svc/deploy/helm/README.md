# coa-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match coa-svc's actual runtime contract (port 3010, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for coa-svc yet.
- DATABASE_URL is expected from an operator-created Secret (`coa-svc-db`), not embedded in this chart.
- VEKTOR_COA_MODE=edge (node-llama-cpp + a local GGUF via VEKTOR_EDGE_MODEL_PATH) is the edge-profile path — this chart's default is the cloud/gRPC mode; an edge deployment needs its own values override plus a volume for the GGUF model.
- coa-svc's edge mode still requires a full Postgres+Qdrant reachable even though the PRD's edge software stack table only lists better-sqlite3 - a real, documented architecture gap (see compose/docker-compose.edge.yml in vektor-edge), not something this chart works around.
