// EDGE-006's core claim, verified against a real Kafka broker (no mocks):
// an edge-sync-svc instance that goes offline, misses messages, and comes
// back on a *fresh process* (new consumer instance, new consumer-group id —
// deliberately not reusing the old one, so this can't accidentally pass by
// relying on Kafka's own committed group offset) still catches up on
// exactly the delta it missed, using only its own local SQLite offset
// trail. See sync/deltaSync.ts's header comment for why that distinction
// matters for a 72h-offline-capable edge node (§11.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kafka } from "kafkajs";
import { openLocalStore } from "../src/db/localStore.js";
import { startDeltaSync } from "../src/sync/deltaSync.js";
import type { EntityUpsertedMessage } from "../src/sync/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function fakeEntity(id: string): EntityUpsertedMessage {
  return { entity_id: id, entity: { entity_id: id, classification: "GroundVehicle.Tracked" } as never, ts: new Date().toISOString() };
}

test("delta sync: a restarted consumer with a fresh group id catches up on exactly the messages missed while offline", async (t) => {
  const kafka = new Kafka({ clientId: "edge-sync-test", brokers: [process.env.KAFKA_BROKERS ?? "localhost:19092"] });
  const topic = `dev.vektor.entities.upserted.test-${randomUUID()}`;

  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
  await admin.disconnect();

  const producer = kafka.producer();
  await producer.connect();
  t.after(() => producer.disconnect());

  async function publish(msg: EntityUpsertedMessage): Promise<void> {
    await producer.send({ topic, messages: [{ key: msg.entity_id, value: JSON.stringify(msg) }] });
  }

  const dir = mkdtempSync(join(tmpdir(), "edge-sync-delta-"));
  const dbPath = join(dir, "edge.sqlite3");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // --- Leg 1: online, consuming live ---
  const store1 = openLocalStore(dbPath);
  const applied1: string[] = [];
  const sync1 = await startDeltaSync({
    kafka,
    groupId: `edge-sync-test-leg1-${randomUUID()}`,
    topic,
    store: store1,
    onApplied: (m) => applied1.push(m.entity_id),
  });

  // Warm-up probes until the consumer group has actually joined and is
  // tailing live — a fresh consumer group's `fromBeginning:false` means
  // anything published before assignment completes (~3s in this sandbox,
  // per vektor-build-conventions) is silently missed, not queued.
  let warmupApplied = false;
  for (let i = 0; i < 20 && !warmupApplied; i++) {
    const probeId = `warmup-leg1-${i}`;
    await publish(fakeEntity(probeId));
    try {
      await waitUntil(() => applied1.includes(probeId), 1000, "warmup probe");
      warmupApplied = true;
    } catch {
      // not ready yet, try another probe
    }
  }
  assert.ok(warmupApplied, "consumer group never became ready to receive live messages");

  await publish(fakeEntity("entity-1"));
  await publish(fakeEntity("entity-2"));
  await publish(fakeEntity("entity-3"));
  await waitUntil(() => applied1.includes("entity-1") && applied1.includes("entity-2") && applied1.includes("entity-3"), 5000, "leg 1 messages");

  assert.equal(store1.getEntity("entity-1")?.entity !== null, true);
  const offsetAfterLeg1 = store1.getOffset(topic, 0);
  assert.ok(offsetAfterLeg1 !== null);

  await sync1.stop();
  store1.close();

  // --- Simulated 72h offline gap: messages arrive with nobody consuming ---
  await publish(fakeEntity("entity-4"));
  await publish(fakeEntity("entity-5"));

  // --- Leg 2: reconnect. Fresh process (new store handle from the same
  // file, new consumer, DIFFERENT group id) — must not rely on Kafka's own
  // committed group offset, only on the local SQLite offset trail.
  const store2 = openLocalStore(dbPath);
  t.after(() => store2.close());
  const applied2: string[] = [];
  const sync2 = await startDeltaSync({
    kafka,
    groupId: `edge-sync-test-leg2-${randomUUID()}`,
    topic,
    store: store2,
    onApplied: (m) => applied2.push(m.entity_id),
  });
  t.after(() => sync2.stop());

  await waitUntil(() => applied2.includes("entity-4") && applied2.includes("entity-5"), 8000, "leg 2 delta messages");

  // The whole point: leg 2 replayed the delta (entity-4/5), not the entire
  // topic history — entity-1/2/3 (and the warmup probes) were never
  // re-applied on this fresh consumer instance.
  assert.equal(applied2.includes("entity-1"), false);
  assert.equal(applied2.includes("entity-2"), false);
  assert.equal(applied2.includes("entity-3"), false);
  assert.ok(!applied2.some((id) => id.startsWith("warmup-leg1")));

  assert.ok(store2.getEntity("entity-4"));
  assert.ok(store2.getEntity("entity-5"));

  const offsetAfterLeg2 = store2.getOffset(topic, 0);
  assert.ok(offsetAfterLeg2 !== null && offsetAfterLeg2 > offsetAfterLeg1!);
});
