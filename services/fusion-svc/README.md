# fusion-svc

Phase 3 (Data Fusion Engine): SVC-007 (kafkajs consumer groups + Redis Streams topology), SVC-008 (Extended Kalman Filter position smoothing), SVC-009 (ontology mapping to the canonical Entity), SVC-010 (blue-force tracking + no-strike zone engine), SVC-011 (EW/RF signal correlation).

Also the Socket.io gateway `apps/web`'s FE-002 (Phase 1) was built against but never had — `src/socket/gateway.ts` emits `entity:new`/`entity:updated`/`entity:lost`/`sensor:status` per §13.2, matching `@vektor/shared`'s `ServerToClientEvents` exactly.

## Data flow

```
Kafka: detection.tracked / ais.position / adsb.position / ewrf.emission
  → src/kafka/ingestConsumers.ts   (schema-validate, land on a per-domain Redis Stream)
  → @vektor/redis's WatermarkWindow (Pitfall 1: release in sensor_ts order, 500ms watermark)
  → src/pipeline/observationMappers.ts (per-domain event → domain-agnostic TrackObservation)
  → src/pipeline/trackManager.ts   (nearest-neighbor correlation/dedup across sensors, REQ-3.1/3.5)
  → src/ekf/extendedKalmanFilter.ts (geodetic position/velocity smoothing, REQ-2.5/3.4)
  → src/blueforce/queries.ts        (no-strike zone check, REQ-3.3)
  → src/ontology/mapToEntity.ts     (→ canonical Entity, REQ-3.2)
  → src/db/upsertEntity.ts          (persist to `entities`, same table geospatial-svc reads)
  → src/socket/gateway.ts           (entity:new / entity:updated / entity:lost)
```

## Scope notes

- **CV `DetectionEvent` tracks carry no real-world position** — only pixel-space bbox/velocity (see `vektor-proto`'s `DetectionEvent` doc comment). No service in this system geo-registers a camera to real-world coordinates, so `detection.tracked` is consumed and windowed here (satisfying SVC-007's topology end-to-end) but produces no `TrackObservation` — see `observationMappers.ts`'s header comment. A future phase's camera geo-registration step would slot in as one more mapper.
- **Association is nearest-neighbor gating**, not a full assignment solver (Hungarian/JPDA) — same complexity tradeoff `cv-inference-svc`'s greedy IoU tracker made over the Hungarian algorithm. Per-domain gate distances (`trackManager.ts`) reflect each sensor's fix precision: AIS/ADS-B are GPS-derived (tight gates), EW/RF geolocation is much less precise (wide gate).
- **EW/RF correlation (SVC-011)** is exactly this same correlation gate applied to `EwRfEmission.estimated_position` — a "join" in the sense that it's still the same Redis-Streams-fed watermark window and the same `TrackManager.correlate()` call every other domain goes through, not a separate algorithm. A bearing-only emission (no `estimated_position`) is windowed but doesn't produce an observation — single-receiver RF geolocation needs a triangulated fix, not a bearing line.
- **Blue-force/no-strike (SVC-010)** is an operator-managed registry (`POST /api/v1/blue-force-assets`), not an automatic feed — no PRD feed publishes friendly-asset positions. Registering an asset auto-generates a meters-accurate buffer zone (`ST_Buffer` via a `geography` cast, not degree-space buffering) kept in sync on every position update; deleting an asset does **not** cascade-delete its zone (a no-strike zone disappearing as a side effect of an unrelated registry edit is the wrong default here).
- **`no_strike_zones.geom` is a polygon column built with a Drizzle `customType`**, not the built-in `geometry()` helper — that helper only supports POINT (see `packages/db/src/schema/blueForce.ts`'s header comment). Every read/write of it goes through raw `sql` (`ST_GeomFromText`/`ST_AsGeoJSON`), never Drizzle's typed query builder.
- **`entities.position` has SRID 0, not 4326`** (an existing Phase 1 characteristic, not something this service changed) — `isInNoStrikeZone` wraps it in `ST_SetSRID(..., 4326)` at the query site. `geospatial-svc`'s own bbox `ST_Contains` query has the same latent mixed-SRID issue and was never caught because no test exercised it against a real inserted-then-queried entity — worth fixing there too, out of scope for this service.

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

# Redis (Streams)
docker run -d --name vektor-dev-redis -p 16379:6379 redis:7-alpine

# PostGIS
docker run -d --name vektor-postgis -e POSTGRES_PASSWORD=vektor -e POSTGRES_DB=vektor -p 5433:5432 postgis/postgis:16-3.4-alpine

pnpm build
DATABASE_URL=postgres://postgres:vektor@localhost:5433/vektor \
KAFKA_BROKERS=localhost:19092 \
REDIS_URL=redis://localhost:16379 \
  pnpm start
```

`apps/web` connects via `NEXT_PUBLIC_SOCKET_URL=http://localhost:3007` (default `PORT`).

Every domain topic (`{env}.vektor.{detection,ais,adsb,ewrf}.*`) must exist before `consumer.subscribe()` — a fresh Kafka instance throws `UNKNOWN_TOPIC_OR_PARTITION` for a topic nothing has ever produced to. `tests/pipeline.integration.test.ts` creates them explicitly via `admin().createTopics()`, same pattern `ingest-svc`'s tests use.
