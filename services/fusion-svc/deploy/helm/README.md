# fusion-svc Helm chart

First real Helm chart in this project — every other service's ArgoCD
`ApplicationSet` entry (`vektor-infra/k8s/argocd/applications/vektor-backend-services.yaml`)
points at `services/<name>/deploy/helm`, none of which existed until now.
Use this as the template for the other 9.

Verified with `helm lint .` and `helm template . --namespace vektor-backend`
(both clean) — not verified against a live cluster (`kubectl`/a real
kubeconfig aren't available in this sandbox).

## What's real vs. still a gap

- Deployment/Service/ServiceAccount are complete and match fusion-svc's
  actual runtime contract: port 3007, `GET /healthz`, and the exact env
  vars `src/index.ts` reads (`DATABASE_URL`, `KAFKA_BROKERS`, `REDIS_URL`,
  `VEKTOR_ENV`, `POLL_BLOCK_MS`, `WATERMARK_MS`).
- The ServiceAccount name is fixed (`fusion-svc`), not derived from the Helm
  release name — SEC-001's deferred Istio `AuthorizationPolicy` work (see
  `vektor-infra`'s istio module and
  [ADR-0012](../../../../../vektor-docs/docs/adr/0012-istio-mtls-before-authz-policy.md))
  was blocked on exactly this not existing anywhere; this chart establishes
  the convention it needs.
- `image.repository` (`ghcr.io/oluwaeinstein007/vektor-fusion-svc`) is a
  placeholder — **no CI in this repo builds or publishes an image for
  fusion-svc yet** (only `cv-inference-svc`/`coa-svc`/`edge-sync-svc` have
  Dockerfiles at all, from Phase 6's edge work; see `.github/workflows/edge-arm64.yml`).
  This chart is deployable in shape, not in practice, until that exists.
- `DATABASE_URL` is expected from an operator-created Secret
  (`fusion-svc-db`, see `values.yaml`'s `existingSecret`), not embedded in
  this chart — create it with
  `kubectl create secret generic fusion-svc-db --from-literal=DATABASE_URL=postgres://...`
  before installing.
