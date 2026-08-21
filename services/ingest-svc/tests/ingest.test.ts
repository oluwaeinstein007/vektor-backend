// End-to-end integration test — deliberately not mocked. A real ffmpeg
// process pulls from a real RTSP source and a real kafkajs producer/consumer
// pair round-trips through a real Kafka broker. Point KAFKA_BROKERS and
// RTSP_SOURCE_URL at your own instances (see README.md); this is the only
// way to actually prove the fluent-ffmpeg -> Kafka pipeline works, the way
// geospatial-svc's tests prove the PostGIS query path works against a real
// database instead of a mocked query builder.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kafka, type Consumer, type Producer } from "kafkajs";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { runIngest } from "../src/app.js";
import type { FrameExtractorHandle } from "../src/rtsp/frameExtractor.js";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const RTSP_SOURCE_URL = process.env.RTSP_SOURCE_URL ?? "rtsp://localhost:8554/testcam";
const TOPIC = topicName("dev", "video", "frame");
const SENSOR_ID = `test-sensor-${randomUUID()}`;

let kafka: Kafka;
let producer: Producer;
let consumer: Consumer;
let handle: FrameExtractorHandle;

interface ReceivedMessage {
  value: Buffer;
  headers: Record<string, string>;
}
const received: ReceivedMessage[] = [];
const frameErrors: Error[] = [];

before(async () => {
  kafka = createKafkaClient({ clientId: `ingest-svc-test-${randomUUID()}`, brokers: KAFKA_BROKERS });

  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  consumer = kafka.consumer({ groupId: `ingest-svc-test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const headers = Object.fromEntries(
        Object.entries(message.headers ?? {}).map(([k, v]) => [k, v?.toString() ?? ""]),
      );
      if (headers.sensor_id === SENSOR_ID) {
        received.push({ value: message.value, headers });
      }
    },
  });

  producer = kafka.producer();
  await producer.connect();

  handle = runIngest({
    sourceUrl: RTSP_SOURCE_URL,
    rtspTransport: "tcp",
    producer,
    env: "dev",
    sensorId: SENSOR_ID,
    onFrameError: (err) => frameErrors.push(err),
  });
});

after(async () => {
  handle.stop();
  await producer.disconnect();
  await consumer.disconnect();
});

test("publishes real extracted frames to Kafka with a valid Entity-adjacent header envelope", async () => {
  const deadline = Date.now() + 20_000;
  while (received.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.ok(
    received.length >= 3,
    `expected >= 3 frames within 20s, got ${received.length} (frame errors: ${frameErrors.map((e) => e.message).join("; ")})`,
  );

  const [first, second] = received;

  // The message value is the raw JPEG, untouched — not JSON, not base64.
  assert.equal(first!.value[0], 0xff);
  assert.equal(first!.value[1], 0xd8);
  assert.equal(first!.value[first!.value.length - 2], 0xff);
  assert.equal(first!.value[first!.value.length - 1], 0xd9);

  assert.equal(first!.headers.sensor_id, SENSOR_ID);
  assert.equal(first!.headers.codec, "mjpeg");
  assert.equal(first!.headers.width, "320");
  assert.equal(first!.headers.height, "240");
  assert.ok(!Number.isNaN(Date.parse(first!.headers.sensor_ts!)), "sensor_ts must be a parseable timestamp");

  // frame_number strictly increases across the real ffmpeg pipe — proves
  // frames aren't being duplicated or reordered by the splitter.
  assert.ok(Number(second!.headers.frame_number) > Number(first!.headers.frame_number));
});
