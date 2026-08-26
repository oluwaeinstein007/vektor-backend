# syntax=docker/dockerfile:1
# EDGE-002: cv-inference-svc edge-profile image. Multi-arch (linux/amd64 +
# linux/arm64 for the Jetson AGX Orin, §11.4) — build with:
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f services/cv-inference-svc/Dockerfile -t vektor/cv-inference-svc:edge-latest \
#     ../../..
# NOTE the build context is VEKTOR/ (three levels up), not this repo — this
# package depends on "@vektor/proto": "link:../../../vektor-proto" (see
# vektor-build-conventions), a relative path across repos. pnpm only
# resolves that correctly if vektor-proto sits at the same relative depth
# inside the image as it does on disk, so both repos are copied in as
# siblings rather than just this one. `pnpm deploy` was tried first as a
# smaller alternative and rejected: it re-resolves link: targets relative to
# the *deploy destination*, silently producing a broken/missing
# @vektor/proto in the output — see vektor-build-conventions memory.
#
# QEMU-emulated ARM64 installs in this sandbox are slow enough that a
# transient registry timeout (better-sqlite3's node-gyp header fetch,
# sharp's libvips download) can fail a ~18min layer right at the end — real,
# observed, not hypothetical. Two mitigations: a BuildKit cache mount for
# pnpm's content-addressable store so a retry doesn't re-download everything
# from zero, and higher pnpm fetch-retry settings than the default (which
# already retries, but not enough times for this network).
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
RUN pnpm --filter=@vektor/cv-inference-svc... build

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="vektor-backend/services/cv-inference-svc"
RUN corepack enable
WORKDIR /workspace
COPY --from=build /workspace/vektor-proto ./vektor-proto/
COPY --from=build /workspace/vektor-backend ./vektor-backend/
ENV NODE_ENV=production
ENV VEKTOR_PROFILE=edge
WORKDIR /workspace/vektor-backend/services/cv-inference-svc
EXPOSE 3006
CMD ["node", "dist/src/index.js"]
