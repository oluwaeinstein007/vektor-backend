# ingest-svc

Phase 1 ingestion: one process, five independently-enabled adapters, sharing one Kafka producer. Each adapter turns on only if its env vars are set — a deployment that needs one feed just sets that adapter's vars.

| Adapter | Task | Env vars | Topic |
|---|---|---|---|
| RTSP/SRT FMV | SVC-001 (REQ-1.1) | `INGEST_SOURCE_URL`, `RTSP_SENSOR_ID` (or `SENSOR_ID`), `RTSP_TRANSPORT` | `{env}.vektor.video.frame` |
| GeoTIFF/SAR inbox | SVC-002 (REQ-1.2) | `GEOTIFF_INBOX_DIR`, `GEOTIFF_SENSOR_ID` | `{env}.vektor.imagery.ingested` |
| AIS | SVC-003 (REQ-1.5) | `AIS_HOST`, `AIS_PORT`, `AIS_SENSOR_ID` | `{env}.vektor.ais.position` |
| ADS-B (SBS-1) | SVC-003 (REQ-1.5) | `ADSB_HOST`, `ADSB_PORT`, `ADSB_SENSOR_ID` | `{env}.vektor.adsb.position` |
| MQTT IoT | SVC-003 (REQ-1.5) | `MQTT_BROKER_URL`, `MQTT_TOPIC_FILTER`, `MQTT_SENSOR_ID` | `{env}.vektor.iot.telemetry` |

Plus `KAFKA_BROKERS` (default `localhost:9092`) and `VEKTOR_ENV` (default `dev`) shared by all adapters.

Also carries the sensor_ts validation half of SVC-004 (`@vektor/kafka`'s `assertValidSensorTs`) — every adapter validates through it before publishing. The NTP/PTP clock-sync daemon itself (SVC-004's other half) is host/infra configuration (chrony/ptp4l), not application code, and isn't part of this repo.

**RTSP/SRT** extracts individual JPEG frames from ffmpeg's MJPEG pipe output and publishes JPEG bytes as the raw Kafka message value with a `VideoFrameMetadata` header envelope — see `src/rtsp/frameExtractor.ts`.

**GeoTIFF/SAR** parses georeferencing (bbox, CRS, dimensions) via `geotiff` (pure JS — the PRD's originally specified `gdal-async` isn't installable in this sandbox; see `src/geotiff/ingestGeoTiff.ts`'s header comment) and watches a drop directory for new files (`src/geotiff/watchInbox.ts`).

**AIS** decodes ITU-R M.1371 Class A position reports (message types 1/2/3) straight from the AIVDM 6-bit-armored payload — `src/ais/aivdmDecoder.ts`. Other AIS message classes (static/voyage data, Class B, base stations) aren't implemented.

**ADS-B** parses the SBS-1 (BaseStation) CSV format emitted by dump1090-class receivers on TCP port 30003 — a text adapter, not a Mode S/RF decoder (`src/adsb/sbs1Parser.ts`).

**MQTT** subscribes to a topic filter and republishes every JSON payload as an `IotTelemetryEvent`, passed through rather than normalized to a per-device schema (`src/mqtt/mqttAdapter.ts`).

## Local development

Every adapter is tested against a real instance of whatever it talks to — no mocks. Bring up only what you need:

```bash
# Kafka (KRaft, single node, no Zookeeper) — needed by every adapter
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

# RTSP/SRT test source (MediaMTX)
docker run -d --name vektor-dev-mediamtx -p 8554:8554 -p 8890:8890/udp bluenviron/mediamtx:latest
# UDP RTSP publish can time out session keepalive in some sandboxed/bridged
# Docker networks — -rtsp_transport tcp is the reliable option for local dev
ffmpeg -stream_loop -1 -re -f lavfi -i testsrc=size=320x240:rate=10 \
  -c:v libx264 -preset ultrafast -f rtsp -rtsp_transport tcp \
  rtsp://localhost:8554/testcam

# MQTT broker (anonymous access — dev only)
mkdir -p /tmp/vektor-mosquitto && printf 'listener 1883\nallow_anonymous true\n' > /tmp/vektor-mosquitto/mosquitto.conf
docker run -d --name vektor-dev-mosquitto -p 11883:1883 \
  -v /tmp/vektor-mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf \
  eclipse-mosquitto:2

pnpm build
KAFKA_BROKERS=localhost:19092 \
INGEST_SOURCE_URL=rtsp://localhost:8554/testcam RTSP_SENSOR_ID=test-cam-1 RTSP_TRANSPORT=tcp \
MQTT_BROKER_URL=mqtt://localhost:11883 MQTT_TOPIC_FILTER='vektor/sensors/#' MQTT_SENSOR_ID=test-iot-1 \
  pnpm start
```

AIS/ADS-B need a real line-delimited TCP feed (an AIS receiver's NMEA-over-TCP output, or dump1090's SBS-1 port) — there's no equivalent lightweight Docker source for either, so local dev against them means pointing `AIS_HOST`/`AIS_PORT` or `ADSB_HOST`/`ADSB_PORT` at a real feed. The test suite instead stands up its own tiny TCP server per adapter (see Testing below).

## Testing

Every adapter's test is a real integration test against real infrastructure — a real ffmpeg process, a real Kafka broker, a real MQTT broker, a real generated GeoTIFF file, or (for AIS/ADS-B, where no lightweight real feed exists) a real local TCP server standing in for the feed:

```bash
KAFKA_BROKERS=localhost:19092 \
RTSP_SOURCE_URL=rtsp://localhost:8554/testcam \
MQTT_BROKER_URL=mqtt://localhost:11883 \
  pnpm test
```

- `tests/ingest.test.ts` — RTSP frame extraction end-to-end (JPEG SOI/EOI on the message value, header envelope, strictly increasing `frame_number`).
- `tests/frameExtractor.test.ts` — MJPEG splitter + JPEG dimension parser in isolation; no external services needed.
- `tests/geotiff.test.ts` — generates a real GeoTIFF via `geotiff`'s own writer, ingests it, and verifies bbox/CRS/dimensions plus the directory-watch trigger.
- `tests/aivdmDecoder.test.ts` — round-trips known field values through an independently-written test-only encoder (`tests/helpers/testAivdmEncoder.ts`) to verify the decoder without a live AIS feed or a trusted reference sentence.
- `tests/aisAdapter.test.ts` / `tests/adsbAdapter.test.ts` — spin up a local TCP server emitting real-format sentences/lines and verify the full adapter → Kafka path.
- `tests/mqttAdapter.test.ts` — a real `mqtt` client stands in for the IoT device.
