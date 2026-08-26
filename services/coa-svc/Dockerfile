# syntax=docker/dockerfile:1
# EDGE-003: coa-svc edge-profile image (VEKTOR_COA_MODE=edge — node-llama-cpp
# local GGUF path, not the cloud gRPC path). Multi-arch for the Jetson AGX
# Orin — see services/cv-inference-svc/Dockerfile for why the build context
# is VEKTOR/ (three levels up), why `pnpm deploy` isn't used, and why this
# uses a BuildKit pnpm-store cache mount + higher fetch-retry settings
# (QEMU-emulated ARM64 installs in this sandbox are slow enough to hit
# transient registry timeouts near the end of an ~18min install layer).
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f services/coa-svc/Dockerfile -t vektor/coa-svc:edge-latest ../../..
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
RUN pnpm --filter=@vektor/coa-svc... build

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="vektor-backend/services/coa-svc"
RUN corepack enable
WORKDIR /workspace
COPY --from=build /workspace/vektor-proto ./vektor-proto/
COPY --from=build /workspace/vektor-backend ./vektor-backend/
ENV NODE_ENV=production
ENV VEKTOR_PROFILE=edge
ENV VEKTOR_COA_MODE=edge
WORKDIR /workspace/vektor-backend/services/coa-svc
EXPOSE 3010
CMD ["node", "dist/src/index.js"]
