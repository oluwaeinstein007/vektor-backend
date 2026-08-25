// SVC-017 — REQ-1.7: "Sync logistics/ERP state via CDC (Debezium-class
// change-data-capture) ... ERP delta reflected in VEKTOR within 60s."
//
// The upstream "ERP" here is a real Postgres table (logistics-svc/README.md)
// with a real Debezium PostgresConnector (pgoutput plugin) registered
// against it via Kafka Connect — confirmed 2026-08-25 producing a genuine
// change-event envelope, not a hand-rolled approximation of one. Kafka
// Connect's default JsonConverter wraps every message as
// `{ schema, payload }`; `payload.op` is Debezium's op code (c=create,
// u=update, d=delete, r=snapshot-read), and `payload.before`/`payload.after`
// carry the row's old/new column values (both null-able depending on op).
import type { Consumer } from "kafkajs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { inventoryItems, inventoryHistory, type VektorDb } from "@vektor/db";

// Debezium's own topic-naming convention (topic.prefix.schema.table), not
// this repo's {env}.vektor.{domain}.{action} convention (topicName()) —
// the prefix was deliberately chosen to still start with "dev.vektor" so
// it reads consistently in a topic listing, but the suffix is Debezium's,
// not ours.
export const ERP_INVENTORY_TOPIC = "dev.vektor.erp.public.inventory";

interface DebeziumInventoryRow {
  item_id: string;
  sku: string;
  name: string;
  category: string;
  quantity: number;
  reorder_threshold: number;
  location: string;
  updated_at: string;
}

interface DebeziumEnvelope {
  payload: {
    op: "c" | "u" | "d" | "r";
    before: DebeziumInventoryRow | null;
    after: DebeziumInventoryRow | null;
  };
}

export interface InventoryCdcOptions {
  consumer: Consumer;
  db: VektorDb;
  onApplied?: (itemId: string, op: string) => void;
  onError?: (err: Error) => void;
}

function parseEnvelope(raw: string): DebeziumEnvelope {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("payload" in parsed)) {
    throw new Error("not a Kafka Connect JsonConverter envelope (missing payload)");
  }
  return parsed as DebeziumEnvelope;
}

async function applyChange(db: VektorDb, envelope: DebeziumEnvelope): Promise<string | null> {
  const { op, before, after } = envelope.payload;

  if (op === "d") {
    const itemId = before?.item_id;
    if (!itemId) return null;
    await db.delete(inventoryItems).where(eq(inventoryItems.item_id, itemId));
    return itemId;
  }

  if (!after) return null; // c/u/r always carry `after`; defensive only

  const updatedAt = new Date(after.updated_at);
  const values = {
    item_id: after.item_id,
    sku: after.sku,
    name: after.name,
    category: after.category,
    quantity: after.quantity,
    reorder_threshold: after.reorder_threshold,
    location: after.location,
    updated_at: updatedAt,
  };

  await db
    .insert(inventoryItems)
    .values(values)
    .onConflictDoUpdate({ target: inventoryItems.item_id, set: values });

  // One history point per CDC event — this is the entire time-series
  // SVC-018's regression forecaster reads (see forecast/regression.ts).
  await db.insert(inventoryHistory).values({ id: randomUUID(), item_id: after.item_id, quantity: after.quantity, ts: updatedAt });

  return after.item_id;
}

export async function runInventoryCdcConsumer(options: InventoryCdcOptions): Promise<void> {
  await options.consumer.subscribe({ topic: ERP_INVENTORY_TOPIC, fromBeginning: true });

  await options.consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const envelope = parseEnvelope(message.value.toString());
        const itemId = await applyChange(options.db, envelope);
        if (itemId) options.onApplied?.(itemId, envelope.payload.op);
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
