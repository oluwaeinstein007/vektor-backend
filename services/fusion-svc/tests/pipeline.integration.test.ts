// End-to-end proof of SVC-007..011 against real infra, no mocks (same bar
// as every other service in this repo): a real Kafka topic carries an AIS
// fix and an EW/RF emission, fusion-svc's own ingest consumer lands them on
// real Redis Streams, the watermark window releases them in sensor_ts
// order, TrackManager correlates the EW/RF fix onto the AIS-originated
// track, the EKF smooths it, the no-strike check runs against a real
// PostGIS no-strike zone, the result lands in real Postgres, and a real
// socket.io-client sees entity:new / entity:updated matching §13.2 exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket } from "socket.io-client";
import { createKafkaClient } from "@vektor/kafka";
import { createRedisClient, WatermarkWindow, streamKey } from "@vektor/redis";
import { createDb } from "@vektor/db";
import type { Entity, EntityUpdatedEvent } from "@vektor/shared";
import { buildApp } from "../src/app.js";
import { FusionGateway } from "../src/socket/gateway.js";
import { runIngestConsumers, fusionTopic, FUSION_DOMAINS } from "../src/kafka/ingestConsumers.js";
import { runPipelineOnce, createTrackManager } from "../src/pipeline/pipeline.js";
import { upsertBlueForceAsset, deleteBlueForceAsset, listNoStrikeZones, deleteNoStrikeZone } from "../src/blueforce/queries.js";

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** gateway.emit() queues the socket.io write but doesn't wait for the client to actually receive it — poll briefly rather than asserting immediately after the pipeline cycle that triggered the emit. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(100);
  }
}

test("AIS fix + EW/RF corroboration flow end-to-end through Kafka, Redis Streams, EKF fusion, PostGIS no-strike, Postgres, and Socket.io", async (t) => {
  const testId = randomUUID();
  const db = createDb(DATABASE_URL);
  const app = buildApp({ db, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const gateway = new FusionGateway(app.server);
  const redis = createRedisClient(REDIS_URL);

  // The Redis Stream keys runIngestConsumers/WatermarkWindow use are fixed
  // production domain names ("ais", "adsb", ...), not test-scoped — a
  // WatermarkWindow always starts reading each stream from position "0".
  // Without this, a fresh test run reads every leftover entry from every
  // prior run of this test too, which looks like instant success but isn't
  // actually proving *this* run's Kafka→Redis flow (confirmed the hard way
  // — see vektor-build-conventions memory).
  await redis.del(...FUSION_DOMAINS.map((d) => streamKey(d)));

  const kafka = createKafkaClient({ clientId: `fusion-test-${testId}`, brokers: [KAFKA_BROKERS] });

  // Fresh Kafka instance — these topics have never been produced to, so
  // subscribing before they exist fails with UNKNOWN_TOPIC_OR_PARTITION.
  // Same explicit admin().createTopics() pattern ingest-svc's tests use.
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({
    topics: FUSION_DOMAINS.map((domain) => ({ topic: fusionTopic("dev", domain), numPartitions: 1 })),
  });
  await admin.disconnect();

  const consumer = kafka.consumer({ groupId: `fusion-test-${testId}` });
  await consumer.connect();
  const producer = kafka.producer();
  await producer.connect();

  const socket: Socket = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
  const entityNewEvents: Entity[] = [];
  const entityUpdatedEvents: EntityUpdatedEvent[] = [];
  socket.on("entity:new", (e: Entity) => entityNewEvents.push(e));
  socket.on("entity:updated", (e: EntityUpdatedEvent) => entityUpdatedEvents.push(e));
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()));

  // Registration order matters (t.after runs FIFO in this Node version —
  // confirmed the hard way in blueForceQueries.test.ts): anything that must
  // run before the DB connection closes has to be registered before it.
  t.after(() => socket.disconnect());
  t.after(() => app.close());
  t.after(() => gateway.close());
  t.after(() => consumer.disconnect());
  t.after(() => producer.disconnect());
  t.after(() => redis.disconnect());
  t.after(() => db.$client.end());

  void runIngestConsumers({
    consumer,
    redis,
    env: "dev",
    onError: (domain, err) => console.error("ingest error", domain, err),
  });

  const assetLat = 12.5;
  const assetLon = 30.5;
  const asset = await upsertBlueForceAsset(db, {
    callsign: `TEST-CP-${testId}`,
    classification: "Base.Friendly",
    position: { lat: assetLat, lon: assetLon, alt_m: 0 },
    buffer_radius_m: 1000,
  });

  const aisSensorId = `test-ais-${testId}`;
  const ewrfSensorId = `test-ewrf-${testId}`;
  const window = new WatermarkWindow(redis, [...FUSION_DOMAINS], 500);
  const trackManager = createTrackManager();

  // Fixed inside the buffer, ~110m from the asset (well within 1000m).
  const fixLat = assetLat + 0.001;
  const fixLon = assetLon;

  function aisEvent(sensorTs: string) {
    return {
      event_id: randomUUID(),
      sensor_id: aisSensorId,
      mmsi: "123456789",
      message_type: 1,
      nav_status: 0,
      lat: fixLat,
      lon: fixLon,
      speed_knots: 10,
      course_deg: 90,
      heading_deg: 90,
      sensor_ts: sensorTs,
      kafka_ts: new Date().toISOString(),
    };
  }

  // kafkajs consumer-group rebalance/assignment takes ~3s in this sandbox
  // (see vektor-build-conventions memory) — a message published before
  // assignment completes is silently skipped (consumer starts at "latest").
  // Retry-publish-and-poll rather than guessing a fixed wait long enough.
  const aisTopic = fusionTopic("dev", "ais");
  let ingestedEntityId: string | null = null;
  const deadline = Date.now() + 60_000;
  while (!ingestedEntityId && Date.now() < deadline) {
    await producer.send({ topic: aisTopic, messages: [{ key: aisSensorId, value: JSON.stringify(aisEvent(new Date().toISOString())) }] });
    await sleep(1500);
    const processed = await runPipelineOnce({ window, trackManager, db, gateway }, 300);
    const match = processed.find((p) => p.domain === "ais");
    if (match) ingestedEntityId = match.entityId;
  }

  assert.ok(ingestedEntityId, "AIS fix should have produced a fused entity within the deadline");
  await waitFor(() => entityNewEvents.length > 0, 5000);
  assert.equal(entityNewEvents.length, 1);
  const created = entityNewEvents[0]!;
  assert.equal(created.entity_id, ingestedEntityId);
  assert.deepEqual(created.source_sensors, [aisSensorId]);
  assert.equal(created.metadata.no_strike, true, "fix inside the blue-force buffer zone should be flagged no_strike");
  assert.ok(Math.abs(created.position.lat - fixLat) < 0.01);

  // Now corroborate the same physical track with an EW/RF fix from a
  // different sensor, close enough (within the ewrf domain's 8000m gate) to
  // correlate onto the already-fused track rather than spawning a new one.
  function ewrfEvent(sensorTs: string) {
    return {
      event_id: randomUUID(),
      sensor_id: ewrfSensorId,
      freq_mhz: 3000,
      bearing_deg: 180,
      signal_strength_dbm: -60,
      modulation: "PSK",
      emitter_classification: "Vessel.AIS",
      sensor_position: { lat: assetLat - 1, lon: assetLon },
      estimated_position: { lat: fixLat + 0.002, lon: fixLon + 0.002, accuracy_m: 3000 },
      sensor_ts: sensorTs,
      kafka_ts: new Date().toISOString(),
    };
  }

  const ewrfTopic = fusionTopic("dev", "ewrf");
  let corroborated = false;
  const ewrfDeadline = Date.now() + 60_000;
  while (!corroborated && Date.now() < ewrfDeadline) {
    await producer.send({ topic: ewrfTopic, messages: [{ key: ewrfSensorId, value: JSON.stringify(ewrfEvent(new Date().toISOString())) }] });
    await sleep(1500);
    await runPipelineOnce({ window, trackManager, db, gateway }, 300);
    corroborated = entityUpdatedEvents.some(
      (e) => e.entity_id === ingestedEntityId && e.entity.source_sensors.includes(ewrfSensorId),
    );
  }

  assert.ok(corroborated, "EW/RF fix should correlate onto the existing AIS-originated track, not spawn a new entity");
  assert.equal(entityNewEvents.length, 1, "still only one entity:new — the EW/RF fix should not have spawned a second track");

  const finalUpdate = entityUpdatedEvents.find(
    (e) => e.entity_id === ingestedEntityId && e.entity.source_sensors.includes(ewrfSensorId),
  )!;
  assert.deepEqual(finalUpdate.entity.source_sensors.sort(), [aisSensorId, ewrfSensorId].sort());

  // Cleanup, before the connection-closing t.after hooks run.
  await deleteBlueForceAsset(db, asset.asset_id);
  const zones = await listNoStrikeZones(db);
  for (const zone of zones.filter((z) => z.source_asset_id === asset.asset_id)) {
    await deleteNoStrikeZone(db, zone.zone_id);
  }
});
