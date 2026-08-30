# cv-inference-svc Helm chart

Follows the same structure as fusion-svc's chart (the first one in this repo) - see that chart's README for the general pattern/rationale. Verified with `helm lint .` and `helm template .` (both clean) — not against a live cluster, none available in this sandbox.

## What's real vs. still a gap

- Deployment/Service/ServiceAccount match cv-inference-svc's actual runtime contract (port 3006, `GET /healthz`, the exact env vars `src/index.ts` reads).
- `image.repository` is a placeholder — no CI in this repo builds/publishes an image for cv-inference-svc yet.
- MODEL_PATH points into the container filesystem — a real deployment needs the ONNX model baked into the image or mounted via a volume, not left as a bare path with nothing behind it.
- REQUIRE_GPU=true (Pitfall 5's fail-fast discipline) needs a GPU-scheduled node (nodeSelector/resources.limits["nvidia.com/gpu"]) - left as false/no GPU request here since no GPU node pool exists in vektor-infra yet.
