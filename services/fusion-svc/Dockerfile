# syntax=docker/dockerfile:1
# SVC-007-011: fusion-svc — the EKF/correlation pipeline plus the Socket.io
# gateway apps/web connects to. Refuses to start without KEYCLOAK_JWKS_URI
# (packages/auth's authOptionsFromEnv throws), so pass it at run time.
#
# Build context is the VEKTOR/ parent directory, NOT this repo — see
# services/DOCKERFILES.md for the full rationale (the cross-repo `link:`
# dependency, why `pnpm deploy` is not used, the protoc codegen step, and
# the BuildKit cache mounts). From VEKTOR/:
#
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -f vektor-backend/services/fusion-svc/Dockerfile \
#     -t ghcr.io/oluwaeinstein007/vektor-fusion-svc:dev .
FROM node:22-bookworm-slim AS build
RUN corepack enable

# Build-stage system packages, in one layer:
#
#   protobuf-compiler — REQUIRED, not optional. vektor-proto's src/generated/
#     is gitignored and src/llm.ts does `export * from "./generated/llm.js"`,
#     so `pnpm build` there fails with TS2307 on any clean checkout until
#     `codegen:ts` has run. The three pre-existing edge Dockerfiles omitted
#     this and only ever succeeded on a machine where the developer had
#     already run codegen locally — reproduced and fixed in NW-001.
#
#   python3/make/g++ — the node-gyp toolchain, needed in EVERY build stage
#     and not just the three services with an obvious native dependency:
#     `pnpm install --filter <svc>...` still pulls better-sqlite3 in
#     transitively via @vektor/db's drizzle-kit devDep, and
#     node:22-bookworm-slim ships no Python, so node-gyp dies with "Could
#     not find any Python installation to use" on services that never touch
#     SQLite. Observed on geospatial-svc, which uses neither.
#
# Acquire::Retries — a long apt transaction dies on one flaky mirror
# response otherwise; reporting-svc's chromium pull failed exactly that way
# on a transient `Err:78 ... libflac12`.
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
      protobuf-compiler python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# QEMU-emulated ARM64 installs are slow enough that a transient registry
# timeout can fail a long layer right at the end — observed repeatedly, not
# hypothetical. The cache mount below keeps a retry from re-downloading
# everything from zero, and these raise pnpm's own retry budget.
ENV PNPM_CONFIG_FETCH_RETRIES=5
ENV PNPM_CONFIG_FETCH_TIMEOUT=120000
ENV PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=60000
WORKDIR /workspace

COPY vektor-proto/ ./vektor-proto/
COPY vektor-backend/ ./vektor-backend/

WORKDIR /workspace/vektor-proto
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile \
 && pnpm run codegen:ts \
 && pnpm run build

WORKDIR /workspace/vektor-backend
# Filtered install: a bare `pnpm install` here resolves every workspace
# package, which means an unrelated service's native postinstall
# (onnxruntime-node's binary download, better-sqlite3's node-gyp build) can
# fail an image that does not depend on it at all. `--filter <pkg>...`
# installs only this service and the workspace packages it actually needs.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile --filter=@vektor/fusion-svc...
RUN pnpm --filter=@vektor/fusion-svc... build

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/oluwaeinstein007/vektor-backend"
LABEL org.opencontainers.image.title="vektor-fusion-svc"
RUN corepack enable
WORKDIR /workspace
COPY --from=build /workspace/vektor-proto ./vektor-proto/
COPY --from=build /workspace/vektor-backend ./vektor-backend/
ENV NODE_ENV=production
WORKDIR /workspace/vektor-backend/services/fusion-svc
EXPOSE 3007
CMD ["node", "dist/src/index.js"]
