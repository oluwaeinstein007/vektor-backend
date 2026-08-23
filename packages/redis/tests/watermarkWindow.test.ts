import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRedisClient } from "../src/client.js";
import { publishToStream } from "../src/streams.js";
import { WatermarkWindow } from "../src/watermarkWindow.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";

function ts(offsetMs: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + offsetMs).toISOString();
}

test("WatermarkWindow releases events in sensor_ts order across domains, not arrival order (Pitfall 1)", async (t) => {
  const redis = createRedisClient({ host: "localhost", port: 16379 });
  t.after(() => redis.disconnect());
  const testId = randomUUID();
  const domains = [`detection-${testId}`, `ais-${testId}`];
  const window = new WatermarkWindow(redis, domains, 500);

  // Arrival order deliberately scrambled relative to sensor_ts: a later
  // sensor_ts arrives first, then an earlier one from a different domain.
  await publishToStream(redis, domains[0]!, ts(2000), { track: "A", seq: 2 });
  await publishToStream(redis, domains[1]!, ts(1000), { track: "B", seq: 1 });

  // Neither is releasable yet: the watermark (max=2000 - 500=1500) would
  // release the ts(1000) event, but poll once more without a newer event to
  // prove the watermark math, not just "everything eventually flushes".
  let batch = await window.poll(0);
  assert.deepEqual(
    batch.map((e) => (e.payload as { seq: number }).seq),
    [1],
    "only the event at/behind the watermark (max 2000 - 500ms = 1500) is released",
  );

  // A much later event pushes the watermark forward, releasing the earlier one.
  await publishToStream(redis, domains[0]!, ts(5000), { track: "A", seq: 3 });
  batch = await window.poll(0);
  assert.deepEqual(
    batch.map((e) => (e.payload as { seq: number }).seq),
    [2],
  );
});

test("WatermarkWindow flushes the remaining buffer on an idle blocking poll", async (t) => {
  const redis = createRedisClient({ host: "localhost", port: 16379 });
  t.after(() => redis.disconnect());
  const testId = randomUUID();
  const domains = [`detection-${testId}`, `ewrf-${testId}`];
  const window = new WatermarkWindow(redis, domains, 500);

  await publishToStream(redis, domains[0]!, ts(0), { seq: 1 });
  await publishToStream(redis, domains[1]!, ts(100), { seq: 2 });

  // First poll reads both existing entries into the buffer but releases
  // neither — the watermark (max 100ms - 500ms) hasn't caught up to either
  // sensor_ts yet.
  const firstBatch = await window.poll(0);
  assert.deepEqual(firstBatch, []);

  // Nothing new will ever arrive on either domain in this test — a second,
  // blocking poll now has nothing left to read and times out. That should
  // give up waiting on the watermark and flush everything still buffered,
  // in sensor_ts order.
  const batch = await window.poll(300);
  assert.deepEqual(
    batch.map((e) => (e.payload as { seq: number }).seq),
    [1, 2],
  );
});
