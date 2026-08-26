import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { openLocalStore } from "../src/db/localStore.js";
import { createIntakeQueue } from "../src/queue/intakeQueue.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";

test("POST /sync/intake accepts a well-formed offline action and enqueues it; GET /sync/status reports real local state", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "edge-sync-app-"));
  const store = openLocalStore(join(dir, "test.sqlite3"));
  // Unique per test — avoids colliding with intakeQueue.test.ts's worker if
  // node:test runs these files concurrently against the same Redis.
  const intakeQueue = createIntakeQueue(REDIS_URL, `edge-sync-intake-test-${randomUUID()}`);
  t.after(async () => {
    store.close();
    await intakeQueue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const topic = `dev.vektor.entities.upserted`;
  store.setOffset(topic, 0, 42n);
  store.applyEntityUpsert("e1", { entity_id: "e1" } as never, "2026-08-25T00:00:00.000Z");

  const app = buildApp({ store, intakeQueue, topic, partitions: [0], logger: false });
  t.after(() => app.close());

  const alertId = randomUUID();
  const intakeRes = await app.inject({
    method: "POST",
    url: "/sync/intake",
    payload: {
      kind: "alert-ack",
      alert_id: alertId,
      action: "ACKNOWLEDGE",
      operator_id: "field-operator-1",
      client_ts: new Date().toISOString(),
    },
  });
  assert.equal(intakeRes.statusCode, 202);
  const intakeBody = intakeRes.json();
  assert.equal(intakeBody.accepted, true);
  assert.ok(intakeBody.job_id);

  const job = await intakeQueue.getJob(intakeBody.job_id);
  assert.ok(job, "job was actually enqueued in Redis, not just accepted at the HTTP layer");
  assert.equal(job!.data.alert_id, alertId);

  const statusRes = await app.inject({ method: "GET", url: "/sync/status" });
  assert.equal(statusRes.statusCode, 200);
  const status = statusRes.json();
  assert.equal(status.entity_count, 1);
  assert.deepEqual(status.offsets, [{ topic, partition: 0, offset: "42" }]);
});

test("POST /sync/intake rejects a malformed payload (missing required field)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "edge-sync-app-"));
  const store = openLocalStore(join(dir, "test.sqlite3"));
  // Unique per test — avoids colliding with intakeQueue.test.ts's worker if
  // node:test runs these files concurrently against the same Redis.
  const intakeQueue = createIntakeQueue(REDIS_URL, `edge-sync-intake-test-${randomUUID()}`);
  t.after(async () => {
    store.close();
    await intakeQueue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = buildApp({ store, intakeQueue, topic: "t", partitions: [], logger: false });
  t.after(() => app.close());

  const res = await app.inject({
    method: "POST",
    url: "/sync/intake",
    payload: { kind: "alert-ack", alert_id: "not-a-uuid", action: "ACKNOWLEDGE" },
  });
  assert.equal(res.statusCode, 400);
});
