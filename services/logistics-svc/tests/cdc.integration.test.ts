// REQ-1.7 end-to-end: a real row inserted into the real "ERP" Postgres
// (vektor-erp-postgres, port 5434) is picked up by the real, already-running
// Debezium PostgresConnector (registered 2026-08-25 against Kafka Connect
// at localhost:8083), lands on the real dev.vektor.erp.public.inventory
// Kafka topic as a genuine Debezium change-event envelope, and this
// service's own consumer decodes and upserts it into VEKTOR's Postgres —
// no hand-rolled stand-in for Debezium's wire format anywhere in this test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, inventoryItems, inventoryHistory, inventoryForecasts } from "@vektor/db";
import { createKafkaClient } from "@vektor/kafka";
import { runInventoryCdcConsumer } from "../src/cdc/inventoryConsumer.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:19092";
const ERP_DATABASE_URL = process.env.ERP_DATABASE_URL ?? "postgres://postgres:vektor@localhost:5434/erp";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(300);
  }
}

test("a real ERP row insert flows through Debezium/Kafka into VEKTOR's own inventory table within 60s", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const kafka = createKafkaClient({ clientId: `logistics-test-${randomUUID()}`, brokers: [KAFKA_BROKERS] });
  const consumer = kafka.consumer({ groupId: `logistics-test-${randomUUID()}` });
  await consumer.connect();
  t.after(() => consumer.disconnect());

  const consumerReady = runInventoryCdcConsumer({ consumer, db });

  // Insert directly against the real ERP Postgres — this is the only step
  // standing in for an actual ERP system; everything downstream of it
  // (Debezium capture, Kafka transport, this service's consumer) is real.
  const { default: postgres } = await import("postgres");
  const erpSql = postgres(ERP_DATABASE_URL);
  t.after(() => erpSql.end());

  const sku = `SKU-TEST-${randomUUID()}`;
  // reorder_threshold deliberately far below quantity — this fixture is
  // only exercising CDC sync, not SVC-018's forecaster, and a leftover
  // (undeleted) item that reads as low-stock would cross-contaminate
  // logistics-svc's own recompute test, which scans every row in
  // inventory_items (found this the hard way 2026-08-25).
  const [inserted] = await erpSql<{ item_id: string }[]>`
    INSERT INTO inventory (sku, name, category, quantity, reorder_threshold, location)
    VALUES (${sku}, 'Test Widget', 'TEST', 250, 1, 'FOB-TEST')
    RETURNING item_id
  `;
  const itemId = inserted!.item_id;

  void consumerReady;

  try {
    const row = await waitFor(async () => {
      const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.item_id, itemId)).limit(1);
      return rows[0] ?? null;
    }, 30_000);

    assert.equal(row.sku, sku);
    assert.equal(row.quantity, 250);

    const history = await db.select().from(inventoryHistory).where(eq(inventoryHistory.item_id, itemId));
    assert.ok(history.length >= 1);
    assert.equal(history[0]!.quantity, 250);

    // A subsequent UPDATE on the ERP side should flow through too.
    await erpSql`UPDATE inventory SET quantity = 200, updated_at = now() WHERE item_id = ${itemId}`;

    await waitFor(async () => {
      const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.item_id, itemId)).limit(1);
      return rows[0]?.quantity === 200 ? rows[0] : null;
    }, 30_000);

    const historyAfterUpdate = await db.select().from(inventoryHistory).where(eq(inventoryHistory.item_id, itemId));
    assert.ok(historyAfterUpdate.length >= 2, "each CDC event should append its own history point");
  } finally {
    await erpSql`DELETE FROM inventory WHERE item_id = ${itemId}`;
    await db.delete(inventoryForecasts).where(eq(inventoryForecasts.item_id, itemId));
    await db.delete(inventoryHistory).where(eq(inventoryHistory.item_id, itemId));
    await db.delete(inventoryItems).where(eq(inventoryItems.item_id, itemId));
  }
});
