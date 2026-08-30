# reporting-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match reporting-svc's actual runtime contract (port 3011, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for reporting-svc yet.
- DATABASE_URL is expected from an operator-created Secret (`reporting-svc-db`), not embedded in this chart.
- PDF generation uses puppeteer-core against the *system's* installed google-chrome binary, not a bundled Chromium download - the container image must actually install a real Chrome/Chromium binary, which no Dockerfile in this repo does yet for this service.
