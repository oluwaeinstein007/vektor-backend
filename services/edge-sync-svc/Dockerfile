# syntax=docker/dockerfile:1
# Part of the edge profile alongside cv-inference-svc/coa-svc (see those
# Dockerfiles' header comments for why the build context is VEKTOR/, three
# levels up, why `pnpm deploy` isn't used, and why this uses a BuildKit
# pnpm-store cache mount + higher fetch-retry settings). No ARM64-specific
# native binding here beyond better-sqlite3 (which ships prebuilt ARM64
# binaries, same low-risk category as sharp) — still built for both
# platforms so `docker compose -f compose/docker-compose.edge.yml build`
# produces a consistent set of images.
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f services/edge-sync-svc/Dockerfile -t vektor/edge-sync-svc:edge-latest ../../..
FROM node:22-bookworm-slim AS build
RUN corepack enable
ENV PNPM_CONFIG_FETCH_RETRIES=5
ENV PNPM_CONFIG_FETCH_TIMEOUT=120000
ENV PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=60000
WORKDIR /workspace

COPY vektor-proto/ ./vektor-proto/
COPY vektor-backend/ ./vektor-backend/

WORKDIR /workspace/vektor-proto
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile && pnpm run build

WORKDIR /workspace/vektor-backend
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile
RUN pnpm --filter=@vektor/edge-sync-svc... build

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="vektor-backend/services/edge-sync-svc"
RUN corepack enable
WORKDIR /workspace
COPY --from=build /workspace/vektor-proto ./vektor-proto/
COPY --from=build /workspace/vektor-backend ./vektor-backend/
ENV NODE_ENV=production
ENV VEKTOR_PROFILE=edge
WORKDIR /workspace/vektor-backend/services/edge-sync-svc
EXPOSE 3012
CMD ["node", "dist/src/index.js"]
