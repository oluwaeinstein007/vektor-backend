// Real Kafka broker, a real JPEG frame published with the exact header
// shape SVC-001's ingest-svc actually produces, real onnxruntime-node
// inference against the checked-in fixture, real DeepSORT tracking, and a
// real consumer reading back the published DetectionEvent — the full
// ML-002/003/004/005 pipeline, not any one piece mocked.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Kafka, type Consumer, type Producer } from "kafkajs";
import { createKafkaClient, topicName } from "@vektor/kafka";
import type { DetectionEvent } from "@vektor/shared";
import { DetectionModel } from "../src/inference/session.js";
import { runFrameConsumer, detectionTopic } from "../src/kafka/processFrames.js";
import { COCO_CLASS_NAMES } from "../src/cocoClasses.js";

const run = promisify(execFile);
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const FRAME_TOPIC = topicName("dev", "video", "frame");
const DETECTION_TOPIC = detectionTopic("dev");
// tsc doesn't copy non-.ts assets into dist/ — import.meta.dirname here is
// dist/tests, so this walks back up to the *source* tests/fixtures/
// directory rather than a dist/tests/fixtures/ that was never populated.
const FIXTURE_PATH = join(import.meta.dirname, "..", "..", "tests", "fixtures", "yolov8n.int8.onnx");
const SENSOR_ID = `test-cv-${randomUUID()}`;

let kafka: Kafka;
let frameProducer: Producer;
let outputConsumer: Consumer;
const received: DetectionEvent[] = [];

before(async () => {
  kafka = createKafkaClient({ clientId: `cv-test-${randomUUID()}`, brokers: KAFKA_BROKERS });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: FRAME_TOPIC, numPartitions: 1 }, { topic: DETECTION_TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  outputConsumer = kafka.consumer({ groupId: `cv-test-out-${randomUUID()}` });
  await outputConsumer.connect();
  await outputConsumer.subscribe({ topic: DETECTION_TOPIC, fromBeginning: true });
  await outputConsumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const event = JSON.parse(message.value.toString("utf-8")) as DetectionEvent;
      if (event.sensor_id === SENSOR_ID) received.push(event);
    },
  });

  frameProducer = kafka.producer();
  await frameProducer.connect();
});

after(async () => {
  await frameProducer.disconnect();
  await outputConsumer.disconnect();
});

async function publishTestFrame(frameNumber: number): Promise<void> {
  const { stdout } = await run(
    "ffmpeg",
    ["-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", "-f", "mjpeg", "-"],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );

  const now = new Date().toISOString();
  await frameProducer.send({
    topic: FRAME_TOPIC,
    messages: [
      {
        key: SENSOR_ID,
        value: stdout as unknown as Buffer,
        headers: {
          sensor_id: SENSOR_ID,
          frame_id: `${SENSOR_ID}-${frameNumber}`,
          frame_number: String(frameNumber),
          sensor_ts: now,
          kafka_ts: now,
        },
      },
    ],
  });
}

test("frames flow through inference + tracking and land on the detection topic with a valid schema", async (t) => {
  const model = await DetectionModel.load(FIXTURE_PATH, { requireGpu: false });
  const consumer = kafka.consumer({ groupId: `cv-inference-svc-test-${randomUUID()}` });
  await consumer.connect();
  // node:test only runs t.after() callbacks, never trailing statements
  // after a thrown assertion — a disconnect() placed after the asserts
  // below would leave this consumer's background heartbeat/session timers
  // running forever on a failed assertion, which is exactly what kept the
  // whole `node --test` process from exiting the first time this test was
  // written without t.after().
  t.after(() => consumer.disconnect());

  const framesProcessed: unknown[] = [];
  const errors: Error[] = [];

  void runFrameConsumer({
    consumer,
    producer: frameProducer,
    model,
    classNames: COCO_CLASS_NAMES,
    env: "dev",
    // Real anchor-level sigmoid scores are essentially never exactly 0.0,
    // so threshold 0 deterministically survives at least one candidate per
    // frame regardless of whether the synthetic test-pattern frame
    // contains anything COCO-recognizable (it doesn't) — this test verifies
    // the pipeline plumbing (inference -> tracking -> valid published
    // schema), not detection accuracy, which a colorbar test pattern was
    // never going to demonstrate against yolov8n.pt anyway. A nonzero
    // threshold here would make the test's pass/fail depend on the model's
    // actual (unpredictable, image-dependent) confidence on this frame.
    confidenceThreshold: 0,
    onDetections: (events) => framesProcessed.push(events),
    onError: (err) => errors.push(err),
  });

  // Consumer group rebalance/partition assignment takes ~3s in this
  // environment (observed via kafkajs's own "Consumer has joined the
  // group" log) — a single fixed wait before publishing is a race: with
  // fromBeginning:false, a frame published before assignment completes
  // starts being read from "latest" *at* assignment time and is skipped
  // forever, not buffered. Publishing repeatedly until something comes
  // back is robust to exactly how long that takes, the same way SVC-001's
  // tests tolerate it by re-publishing continuously rather than timing a
  // single publish against an unobserved rebalance.
  let frameNumber = 0;
  const deadline = Date.now() + 30_000;
  while (received.length === 0 && Date.now() < deadline) {
    frameNumber += 1;
    await publishTestFrame(frameNumber);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  assert.deepEqual(errors, [], "frame processing must not error");
  assert.ok(received.length > 0, "expected at least one tracked detection published");

  const event = received[0]!;
  assert.equal(event.sensor_id, SENSOR_ID);
  assert.match(event.track_id, /^[0-9a-f-]{36}$/i);
  assert.equal(event.bbox.length, 4);
  assert.ok(COCO_CLASS_NAMES.includes(event.class));
  assert.ok(typeof event.velocity_px_per_frame.vx === "number");
  assert.ok(event.heading_deg >= 0 && event.heading_deg <= 360);
});

test("a frame published without sensor_id/frame_id/sensor_ts headers is silently skipped, not errored", async (t) => {
  const model = await DetectionModel.load(FIXTURE_PATH, { requireGpu: false });
  const consumer = kafka.consumer({ groupId: `cv-inference-svc-test-${randomUUID()}` });
  await consumer.connect();
  t.after(() => consumer.disconnect());

  const framesProcessed: unknown[] = [];
  const errors: Error[] = [];
  void runFrameConsumer({
    consumer,
    producer: frameProducer,
    model,
    classNames: COCO_CLASS_NAMES,
    env: "dev",
    onDetections: (events) => framesProcessed.push(events),
    onError: (err) => errors.push(err),
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
  await frameProducer.send({
    topic: FRAME_TOPIC,
    messages: [{ key: "malformed", value: Buffer.from("not-a-real-frame"), headers: {} }],
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.deepEqual(errors, [], "a frame with missing headers must be skipped, not thrown");
  assert.deepEqual(framesProcessed, [], "onDetections must not fire for a skipped frame");
});
