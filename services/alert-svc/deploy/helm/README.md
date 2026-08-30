# alert-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match alert-svc's actual runtime contract (port 3013, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for alert-svc yet.
- DATABASE_URL/TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are expected from an operator-created Secret (`alert-svc-secrets`), not embedded in this chart.

