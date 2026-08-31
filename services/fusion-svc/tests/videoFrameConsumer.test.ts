// Real Kafka, no mocks — same bar as every other test in this repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { runVideoFrameConsumer, type RelayedVideoFrame } from "../src/kafka/videoFrameConsumer.js";

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(100);
  }
}

test("relays a raw-bytes video frame to onFrame, decoding headers and base64-encoding the JPEG value", async (t) => {
  const testId = randomUUID();
  // Fixed production topic name (like pipeline.integration.test.ts) — this
  // test isolates itself via a unique consumer groupId + fromBeginning:
  // false (runVideoFrameConsumer's own subscribe option) rather than a
  // fresh topic, since VektorEnv is a closed "dev"|"staging"|"prod" union.
  const env = "dev";
  const topic = topicName(env, "video", "frame");

  const kafka = createKafkaClient({ clientId: `video-frame-test-${testId}`, brokers: [KAFKA_BROKERS] });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
  await admin.disconnect();

  const producer = kafka.producer();
  await producer.connect();
  t.after(() => producer.disconnect());

  const consumer = kafka.consumer({ groupId: `video-frame-test-${testId}` });
  await consumer.connect();
  t.after(() => consumer.disconnect());

  const received: RelayedVideoFrame[] = [];
  const consumerPromise = runVideoFrameConsumer({
    consumer,
    env,
    minIntervalMs: 0,
    onFrame: (frame) => received.push(frame),
    onError: (err) => t.diagnostic(`consumer error: ${err.message}`),
  });
  void consumerPromise;

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9]);
  const capturedAt = new Date().toISOString();

  // Consumer-group rebalance takes ~3s in this sandbox — publish in a retry
  // loop rather than guessing a fixed wait (documented pitfall: a message
  // published before assignment completes is silently skipped forever).
  while (received.length === 0 && !t.signal.aborted) {
    await producer.send({
      topic,
      messages: [
        {
          key: "phone-camera",
          value: jpegBytes,
          headers: {
            sensor_id: "phone-camera",
            frame_number: "42",
            width: "1920",
            height: "1080",
            sensor_ts: capturedAt,
          },
        },
      ],
    });
    await waitFor(() => received.length > 0, 1500);
  }

  assert.equal(received.length, 1);
  assert.equal(received[0]!.sensorId, "phone-camera");
  assert.equal(received[0]!.frameNumber, 42);
  assert.equal(received[0]!.width, 1920);
  assert.equal(received[0]!.height, 1080);
  assert.equal(received[0]!.capturedAt, capturedAt);
  assert.equal(received[0]!.jpegBase64, jpegBytes.toString("base64"));
});

test("throttles to at most one relayed frame per sensor_id within minIntervalMs", async (t) => {
  const testId = randomUUID();
  const env = "dev";
  const topic = topicName(env, "video", "frame");

  const kafka = createKafkaClient({ clientId: `video-frame-throttle-test-${testId}`, brokers: [KAFKA_BROKERS] });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
  await admin.disconnect();

  const producer = kafka.producer();
  await producer.connect();
  t.after(() => producer.disconnect());

  const consumer = kafka.consumer({ groupId: `video-frame-throttle-test-${testId}` });
  await consumer.connect();
  t.after(() => consumer.disconnect());

  const received: RelayedVideoFrame[] = [];
  void runVideoFrameConsumer({
    consumer,
    env,
    minIntervalMs: 60_000, // effectively "never again" for the duration of this test
    onFrame: (frame) => received.push(frame),
  });

  function publish(frameNumber: number): Promise<void> {
    return producer
      .send({
        topic,
        messages: [
          {
            key: "phone-camera",
            value: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
            headers: {
              sensor_id: "phone-camera",
              frame_number: String(frameNumber),
              width: "640",
              height: "480",
              sensor_ts: new Date().toISOString(),
            },
          },
        ],
      })
      .then(() => undefined);
  }

  while (received.length === 0 && !t.signal.aborted) {
    await publish(1);
    await waitFor(() => received.length > 0, 1500);
  }
  assert.equal(received.length, 1, "first frame should always be forwarded");

  // A second, third, fourth frame published immediately after must all be
  // dropped by the per-sensor throttle — give the consumer ample time to
  // have processed them if it were (wrongly) going to forward any.
  await publish(2);
  await publish(3);
  await sleep(2000);
  assert.equal(received.length, 1, "frames published within minIntervalMs must be dropped, not queued or forwarded");
});
