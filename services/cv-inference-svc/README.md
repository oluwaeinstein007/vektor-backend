# cv-inference-svc

Phase 2 (CV & Tracking Pipeline): ML-002 (onnxruntime-node inference), ML-003 (Kafka frame consumer → detection publisher), ML-004 (DeepSORT-style tracker), ML-005 (Kalman-filter velocity/heading), ML-006 (ONNX hot-swap endpoint).

Consumes raw JPEG frames from `{env}.vektor.video.frame` (SVC-001/`ingest-svc`), runs YOLOv8 ONNX inference, tracks detections across frames with persistent IDs (DeepSORT — Kalman filter + greedy IoU association, `src/tracker/`), and publishes tracked `DetectionEvent`s to `{env}.vektor.detection.tracked`.

## Scope notes

- **GPU**: `src/inference/session.ts` implements Pitfall 5's fail-fast discipline — `REQUIRE_GPU=true` never falls back to CPU silently; a CUDA init failure throws immediately instead of quietly running 10-50x slower. Defaults to `false` (CPU) since most local dev/CI has no GPU.
- **ML-005 velocity/heading** comes from the DeepSORT Kalman filter's `[vx, vy]` state, not optical flow — the PRD's originally specified `opencv4nodejs` needs a full OpenCV source build with no prebuilt binary, which isn't installable in this sandbox (same class of problem as `gdal-async` in SVC-002). REQ-2.5 explicitly allows either path. This is image-space pixel velocity per processed frame, not real-world geodetic velocity — fusion-svc's EKF (SVC-008, Phase 3) does that conversion once a track is correlated with a real position.
- **Track association** is greedy IoU matching, not the Hungarian algorithm DeepSORT normally uses — see `src/tracker/trackAssociation.ts`'s comment for why that's an acceptable simplification here.
- **Default class set** is COCO's 80 classes (`src/cocoClasses.ts`) — matches Ultralytics' pretrained `yolov8n.pt`. A VEKTOR-specific model (trained on the Epic 1 class tree via `vektor-ml/cv-train-svc`) replaces it through the ML-006 hot-swap endpoint; pass `CLASS_NAMES` (comma-separated) to override at startup.

## Local development

```bash
# Kafka (KRaft, single node, no Zookeeper)
docker run -d --name vektor-dev-kafka -p 19092:9092 \
  -e KAFKA_NODE_ID=1 \
  -e KAFKA_PROCESS_ROLES=broker,controller \
  -e KAFKA_LISTENERS=PLAINTEXT://:9092,CONTROLLER://:9093 \
  -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:19092 \
  -e KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER \
  -e KAFKA_CONTROLLER_QUORUM_VOTERS=1@localhost:9093 \
  -e KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
  -e CLUSTER_ID=vektor-dev-cluster-id \
  apache/kafka:3.9.0

pnpm build
MODEL_PATH=./tests/fixtures/yolov8n.int8.onnx KAFKA_BROKERS=localhost:19092 pnpm start
```

`onnxruntime-node` and `sharp` both ship native addons behind a postinstall script — pnpm blocks postinstall scripts by default, so the workspace root `package.json` explicitly lists both in `pnpm.onlyBuiltDependencies`. If either fails to load (`Cannot find module`, `.so` load errors), run `pnpm rebuild onnxruntime-node sharp` from the workspace root.

`POST /api/v1/models/upload` (multipart, field name `file`, SuperAdmin-only once auth-svc exists — not wired up yet, same gap `geospatial-svc` flagged) hot-swaps the active model; `GET /healthz` reports the active execution provider.

## Testing

Every test runs against real infrastructure — a real Kafka broker, real onnxruntime-node inference against a real checked-in ONNX model, a real Fastify app via `app.inject()`, and (for `session.test.ts`/`processFrames.test.ts`) a real ffmpeg-generated JPEG frame:

```bash
KAFKA_BROKERS=localhost:19092 pnpm test
```

See `tests/fixtures/README.md` for why the ONNX models are checked in rather than generated at test time (the one deliberate exception to this project's "generate real fixtures fresh" pattern — `vektor-platform` and `vektor-ml` never share a runtime, so a TS test can't shell out to Python to build one).

`tests/kalmanFilter.test.ts`, `tests/trackAssociation.test.ts`, `tests/deepSortTracker.test.ts`, and `tests/postprocess.test.ts` are pure-logic tests — no external services needed for those alone.
