# audit-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match audit-svc's actual runtime contract (port 3009, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for audit-svc yet.
- DATABASE_URL is expected from an operator-created Secret (`audit-svc-db`), not embedded in this chart.
- Postgres RLS on audit_log (ADR-0011) is enforced at the database role level, not by this chart - the DATABASE_URL Secret must point at the real non-superuser vektor_app role, not a superuser connection, or the RLS guarantee is silently bypassed.
