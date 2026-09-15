// Verifies ingestConsumers.ts's getSensorCoverage enrichment against a real
// Kafka broker + Redis — the only new logic this feature added to the
// consumer path (the registry storage/REST layer is covered by
// sensorRegistry.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createKafkaClient } from "@vektor/kafka";
import { createRedisClient, streamKey } from "@vektor/redis";
import type { SensorHealth } from "@vektor/shared";
import { runIngestConsumers, fusionTopic, FUSION_DOMAINS } from "../src/kafka/ingestConsumers.js";

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iotEvent(sensorId: string) {
  return {
    event_id: randomUUID(),
    sensor_id: sensorId,
    mqtt_topic: "sensor-coverage-test",
    payload: {},
    sensor_ts: new Date().toISOString(),
    kafka_ts: new Date().toISOString(),
  };
}

test("getSensorCoverage enriches sensor:status for a registered sensor and stays null for an unregistered one", async (t) => {
  const testId = randomUUID();
  const redis = createRedisClient(REDIS_URL);
  t.after(() => redis.disconnect());
  // Only reset the "iot" stream this test actually produces to — deleting
  // every domain's stream key (as pipeline.integration.test.ts's comment
  // describes for its own reset) would race-wipe data another concurrently
  // running test file (e.g. pipeline.integration.test.ts, which uses
  // "ais"/"ewrf") already published but hasn't consumed yet. Node's test
  // runner runs separate test files concurrently by default, and these
  // Redis Stream keys are fixed per-domain, not test-scoped — confirmed
  // the hard way when this test's shared-domain use of "ais" intermittently
  // fed pipeline.integration.test.ts a foreign sensor_id.
  await redis.del(streamKey("iot"));

  const kafka = createKafkaClient({ clientId: `sensor-coverage-test-${testId}`, brokers: [KAFKA_BROKERS] });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: FUSION_DOMAINS.map((domain) => ({ topic: fusionTopic("dev", domain), numPartitions: 1 })) });
  await admin.disconnect();

  const producer = kafka.producer();
  await producer.connect();
  t.after(() => producer.disconnect());

  const consumer = kafka.consumer({ groupId: `sensor-coverage-test-${testId}` });
  await consumer.connect();
  t.after(() => consumer.disconnect());

  const registeredSensorId = `test-registered-${testId}`;
  const unregisteredSensorId = `test-unregistered-${testId}`;
  const coverage = { position: { lat: 10, lon: 20 }, coverage_radius_m: 50_000 };

  const healthEvents: SensorHealth[] = [];
  void runIngestConsumers({
    consumer,
    redis,
    env: "dev",
    onSensorHealth: (health) => healthEvents.push(health),
    getSensorCoverage: (sensorId) => (sensorId === registeredSensorId ? coverage : null),
    onError: () => {},
  });

  const iotTopic = fusionTopic("dev", "iot");
  const hasBoth = () =>
    healthEvents.some((h) => h.sensor_id === registeredSensorId) &&
    healthEvents.some((h) => h.sensor_id === unregisteredSensorId);

  // Same consumer-group-rebalance retry-publish pattern as
  // pipeline.integration.test.ts — a message published before the group
  // finishes assigning partitions is silently skipped, not queued.
  const deadline = Date.now() + 60_000;
  while (!hasBoth() && Date.now() < deadline) {
    await producer.send({
      topic: iotTopic,
      messages: [
        { key: registeredSensorId, value: JSON.stringify(iotEvent(registeredSensorId)) },
        { key: unregisteredSensorId, value: JSON.stringify(iotEvent(unregisteredSensorId)) },
      ],
    });
    await sleep(1500);
  }

  const registeredHealth = healthEvents.find((h) => h.sensor_id === registeredSensorId);
  const unregisteredHealth = healthEvents.find((h) => h.sensor_id === unregisteredSensorId);

  assert.ok(registeredHealth, "expected a sensor:status for the registered sensor within the deadline");
  assert.deepEqual(registeredHealth!.position, coverage.position);
  assert.equal(registeredHealth!.coverage_radius_m, coverage.coverage_radius_m);

  assert.ok(unregisteredHealth, "expected a sensor:status for the unregistered sensor within the deadline");
  assert.equal(unregisteredHealth!.position, null);
  assert.equal(unregisteredHealth!.coverage_radius_m, null);
});
