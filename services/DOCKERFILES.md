# Service container images

Every service in this directory has a `Dockerfile` built from one template
(NW-001). This file holds the rationale they all share, so each Dockerfile's
own header can stay about that service.

## Build from `VEKTOR/`, not from this repo

Every image's build context is the **parent directory containing all seven
repos**, not `vektor-backend/`. From `VEKTOR/`:

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f vektor-backend/services/fusion-svc/Dockerfile \
  -t ghcr.io/oluwaeinstein007/vektor-fusion-svc:dev \
  .
```

The reason is `packages/shared`'s dependency on the sibling repo:

```json
"@vektor/proto": "link:../../../vektor-proto"
```

pnpm resolves that relative path literally, so `vektor-proto` has to sit at
the same relative depth inside the image as it does on disk. Both repos are
copied in as siblings.

**`pnpm deploy --legacy` was tried first and rejected.** It re-resolves
`link:` targets relative to the *deploy destination*, which silently
produces an image with a missing `@vektor/proto` — it builds, it starts, and
it fails at the first import.

## Every image runs protoc itself

`vektor-proto/src/generated/` is in that repo's `.gitignore`, and
`vektor-proto/src/llm.ts` does `export * from "./generated/llm.js"`. So on a
clean checkout `pnpm build` in `vektor-proto` fails:

```
src/llm.ts(20,15): error TS2307: Cannot find module './generated/llm.js'
```

Each Dockerfile therefore installs `protobuf-compiler` and runs
`pnpm run codegen:ts` before `pnpm run build`.

This was a real latent bug, not a precaution. The three pre-existing edge
Dockerfiles (`cv-inference-svc`, `coa-svc`, `edge-sync-svc`) had no codegen
step, and neither did `.github/workflows/edge-arm64.yml`, which checks both
repos out fresh and builds immediately. Those builds only ever succeeded on
a machine where a developer had already run codegen locally and the
populated `src/generated/` got swept into the build context. The root
`.dockerignore` now excludes `vektor-proto/src/generated` precisely so a
local build can't accidentally differ from a clean one again.

## Cache mounts and fetch retries

Each install layer uses a BuildKit cache mount on pnpm's content-addressable
store, and raises pnpm's fetch retry settings:

```dockerfile
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --no-frozen-lockfile
```

Under QEMU-emulated ARM64 a full workspace install takes long enough that a
single transient registry timeout near the end fails the whole layer. This
was observed repeatedly during Phase 6 (`better-sqlite3`'s node-gyp header
fetch and a DNS blip were the two real cases). The cache mount means a retry
reuses what already downloaded instead of starting from zero.

`--no-frozen-lockfile` rather than `--frozen-lockfile`: the lockfile is
resolved for the host platform, and the ARM64 install legitimately needs
different optional native packages.

## What each image is and isn't

- **Multi-stage**, but the runtime stage copies the whole built workspace
  rather than a pruned production tree. That keeps devDependencies in the
  image and makes it larger than it needs to be. It is deliberate for now —
  pruning here means solving the `link:` problem a second time, and
  `pnpm deploy` is the tool that would normally do it. Worth revisiting when
  image size becomes a real constraint.
- **No non-root user yet.** A real hardening pass should add one; flagged
  rather than silently skipped.
- **No healthcheck.** Every service exposes `GET /healthz`; the Helm charts
  in each service's `deploy/helm/` wire liveness/readiness probes to it, so
  the Dockerfile-level `HEALTHCHECK` would only matter for plain Docker runs.

## Services with extra system packages

| Service | Extra packages | Why |
|---|---|---|
| `ingest-svc` | `ffmpeg` | `fluent-ffmpeg` shells out to a real binary for RTSP/SRT frame extraction |
| `reporting-svc` | `chromium`, `fonts-liberation`, `fonts-dejavu-core` | `puppeteer-core` deliberately bundles no browser; `CHROME_EXECUTABLE_PATH` points at the distro one |

Everything else runs on the stock `node:22-bookworm-slim` runtime. The
native-binding services (`cv-inference-svc`/onnxruntime-node,
`coa-svc`/node-llama-cpp, `edge-sync-svc`/better-sqlite3) all ship prebuilt
binaries for both architectures and need no build toolchain.

## Ports

| Service | Port | | Service | Port |
|---|---|---|---|---|
| `geospatial-svc` | 3005 | | `reporting-svc` | 3011 |
| `cv-inference-svc` | 3006 | | `edge-sync-svc` | 3012 |
| `fusion-svc` | 3007 | | `alert-svc` | 3013 |
| `map-tile-server` | 3008 | | `logistics-svc` | 3014 |
| `audit-svc` | 3009 | | `ingest-svc` (field) | 3016 |
| `coa-svc` | 3010 | | `mavlink-bridge` | — (no listener) |

`ingest-svc` moved from 3011 to 3016 in NW-003: it collided with
`reporting-svc`, and 3016 is what `vektor-web`'s `api-client.ts` had assumed
for `NEXT_PUBLIC_FIELD_INGEST_URL` all along.
