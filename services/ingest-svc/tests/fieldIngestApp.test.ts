// Real Kafka, no mocks — same bar as every other test in this repo.
// Fastify's own app.inject() (not a real listening socket) is the
// established pattern for this repo's route tests (see coa-svc's
// coaRoutes.test.ts) — it still exercises the real app/route/validation
// stack, just skips the TCP round-trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { buildFieldIngestApp } from "../src/http/app.js";

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";
const DEVICE_SECRET = "test-secret";
const ENV = "dev";

const VALID_TELEMETRY_BODY = {
  device_id: "test-phone-1",
  lat: 7.13555,
  lon: 3.40772,
  alt_m: 200,
};

function fakeJpeg(): Buffer {
  // Minimal-but-real SOI + SOF0(64x48) + EOI, same shape parseJpegDimensions
  // (and by extension publishFrame's dimension check) actually parses —
  // not an arbitrary byte blob, since an UnparsableFrameError-triggering
  // input is covered by its own separate test.
  return Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x30, 0x00, 0x40, 0x01, 0x01, 0x11, 0x00, // SOF0, height=48, width=64
    0xff, 0xd9, // EOI
  ]);
}

async function buildTestApp() {
  const kafka = createKafkaClient({ clientId: `field-ingest-test-${randomUUID()}`, brokers: [KAFKA_BROKERS] });
  const producer = kafka.producer();
  await producer.connect();
  const app = buildFieldIngestApp({ producer, env: ENV, deviceSharedSecret: DEVICE_SECRET, logger: false });
  return { app, producer };
}

test("POST /api/v1/field/telemetry accepts a valid body with the right device key", async (t) => {
  const { app, producer } = await buildTestApp();
  t.after(async () => {
    await app.close();
    await producer.disconnect();
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/field/telemetry",
    headers: { "content-type": "application/json", "x-vektor-device-key": DEVICE_SECRET },
    payload: VALID_TELEMETRY_BODY,
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().status, "accepted");
});

test("POST /api/v1/field/telemetry rejects a missing or wrong device key with 401", async (t) => {
  const { app, producer } = await buildTestApp();
  t.after(async () => {
    await app.close();
    await producer.disconnect();
  });

  const noKey = await app.inject({ method: "POST", url: "/api/v1/field/telemetry", payload: VALID_TELEMETRY_BODY });
  assert.equal(noKey.statusCode, 401);

  const wrongKey = await app.inject({
    method: "POST",
    url: "/api/v1/field/telemetry",
    headers: { "x-vektor-device-key": "wrong" },
    payload: VALID_TELEMETRY_BODY,
  });
  assert.equal(wrongKey.statusCode, 401);
});

test("POST /api/v1/field/snapshot publishes a real, decodable frame onto video.frame, incrementing frame_number per device", async (t) => {
  const { app, producer } = await buildTestApp();
  t.after(async () => {
    await app.close();
    await producer.disconnect();
  });

  const deviceId = `snapshot-test-${randomUUID()}`;
  const consumerKafka = createKafkaClient({ clientId: `field-ingest-test-consumer-${randomUUID()}`, brokers: [KAFKA_BROKERS] });
  const consumer = consumerKafka.consumer({ groupId: `field-ingest-test-${randomUUID()}` });
  await consumer.connect();
  t.after(() => consumer.disconnect());

  const received: Array<{ headers: Record<string, string>; value: Buffer }> = [];
  await consumer.subscribe({ topics: [topicName(ENV, "video", "frame")], fromBeginning: false });
  const runPromise = consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) {
        if (v !== undefined) headers[k] = v.toString();
      }
      if (headers.sensor_id === deviceId) received.push({ headers, value: message.value });
    },
  });
  void runPromise;

  async function postSnapshot(): Promise<number> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/field/snapshot",
      headers: { "content-type": "image/jpeg", "x-vektor-device-key": DEVICE_SECRET, "x-vektor-device-id": deviceId },
      payload: fakeJpeg(),
    });
    return res.statusCode;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Consumer-group rebalance takes ~3s in this sandbox — retry the first
  // POST until it's actually been seen, same pattern every other Kafka test
  // in this repo uses (a message sent before assignment completes is
  // silently skipped forever, not queued). Each retry still increments the
  // per-device counter (correct — a real camera doesn't know or care
  // whether anyone's consuming yet), so the first *received* frame's
  // frame_number isn't necessarily "1"; assert the increment, not an
  // absolute value.
  let firstStatus = 0;
  while (received.length === 0 && !t.signal.aborted) {
    firstStatus = await postSnapshot();
    await sleep(1500);
  }
  assert.equal(firstStatus, 202);
  assert.equal(received.length, 1);
  const firstFrameNumber = Number(received[0]!.headers.frame_number);
  assert.ok(Number.isInteger(firstFrameNumber) && firstFrameNumber >= 1);
  assert.equal(received[0]!.headers.width, "64");
  assert.equal(received[0]!.headers.height, "48");
  assert.equal(received[0]!.headers.codec, "mjpeg");
  assert.deepEqual(received[0]!.value, fakeJpeg());

  const secondStatus = await postSnapshot();
  assert.equal(secondStatus, 202);
  await sleep(1000);
  assert.equal(received.length, 2, "second snapshot from the same device should also be relayed");
  assert.equal(
    Number(received[1]!.headers.frame_number),
    firstFrameNumber + 1,
    "frame_number must increment by exactly 1 per device across requests",
  );
});

test("POST /api/v1/field/snapshot rejects a body missing X-Vektor-Device-Id with 400", async (t) => {
  const { app, producer } = await buildTestApp();
  t.after(async () => {
    await app.close();
    await producer.disconnect();
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/field/snapshot",
    headers: { "content-type": "image/jpeg", "x-vektor-device-key": DEVICE_SECRET },
    payload: fakeJpeg(),
  });
  assert.equal(res.statusCode, 400);
});

test("POST /api/v1/field/snapshot rejects a body with no valid JPEG SOF0 marker with 400", async (t) => {
  const { app, producer } = await buildTestApp();
  t.after(async () => {
    await app.close();
    await producer.disconnect();
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/field/snapshot",
    headers: { "content-type": "image/jpeg", "x-vektor-device-key": DEVICE_SECRET, "x-vektor-device-id": "test-device" },
    payload: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), // SOI+EOI only, no SOF0
  });
  assert.equal(res.statusCode, 400);
});
