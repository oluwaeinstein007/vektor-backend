# ingest-svc

SVC-001: `fluent-ffmpeg` RTSP/SRT → `kafkajs` producer (REQ-1.1). Pulls raw FMV frames off a live source, extracts individual JPEG frames from ffmpeg's MJPEG pipe output, and publishes each one to Kafka — JPEG bytes as the message value, a `sensor_ts`-validated `VideoFrameMetadata` envelope (`@vektor/proto`) as message headers.

Also carries the sensor_ts validation half of SVC-004 (`@vektor/kafka`'s `assertValidSensorTs`) — every event with a `sensor_id`/`sensor_ts` pair should validate through it before publishing, not just this service. The NTP/PTP clock-sync daemon itself (SVC-004's other half) is host/infra configuration (chrony/ptp4l), not application code, and isn't part of this repo.

## Local development

Needs a real RTSP/SRT source and a real Kafka broker — frame extraction and Kafka header/value framing are exactly the things worth proving against real ffmpeg/broker behavior, not mocks.

```bash
# RTSP/SRT test source (MediaMTX)
docker run -d --name vektor-dev-mediamtx -p 8554:8554 -p 8890:8890/udp bluenviron/mediamtx:latest

# publish a synthetic test stream — UDP RTSP publish can time out session
# keepalive in some sandboxed/bridged Docker networks; -rtsp_transport tcp
# is the reliable option for local dev
ffmpeg -stream_loop -1 -re -f lavfi -i testsrc=size=320x240:rate=10 \
  -c:v libx264 -preset ultrafast -f rtsp -rtsp_transport tcp \
  rtsp://localhost:8554/testcam

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
INGEST_SOURCE_URL=rtsp://localhost:8554/testcam SENSOR_ID=test-cam-1 \
  RTSP_TRANSPORT=tcp KAFKA_BROKERS=localhost:19092 pnpm start
```

## Testing

`tests/ingest.test.ts` is a real end-to-end test: it runs the actual frame extractor against the live RTSP source above and asserts on messages consumed back out of the real `dev.vektor.video.frame` topic (JPEG SOI/EOI on the message value, header envelope shape, strictly increasing `frame_number`). Point it at your own instances via env vars if they're not on the defaults:

```bash
KAFKA_BROKERS=localhost:19092 RTSP_SOURCE_URL=rtsp://localhost:8554/testcam pnpm test
```

`tests/frameExtractor.test.ts` covers the MJPEG frame splitter and JPEG dimension parser in isolation (including one case that shells out to a real `ffmpeg` to produce a real encoded frame, rather than a hand-built byte sequence) — no external services needed for that file alone.
