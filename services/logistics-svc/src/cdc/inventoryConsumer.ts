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

/**
 * Accepts BOTH Kafka Connect envelope shapes, because which one you get is
 * a deployment setting rather than a property of Debezium:
 *
 *   schemas.enable=true  (Connect's default) -> { schema, payload: {op,...} }
 *   schemas.enable=false                     -> { op, before, after, ... }
 *
 * This used to require the `payload` wrapper and threw on anything else.
 * That was fine against the instance it was first verified on, which had
 * schemas on, and then NW-003's compose set
 * CONNECT_VALUE_CONVERTER_SCHEMAS_ENABLE=false — so every message threw and
 * logistics-svc's CDC test hung until it timed out. The compose default is
 * corrected alongside this, but tolerating both is the real fix: a customer
 * ERP's Connect is not ours to configure, and failing on a converter
 * setting is not a useful failure mode.
 */
function parseEnvelope(raw: string): DebeziumEnvelope {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("CDC message is not a JSON object");
  }
  // Wrapped form: trust `payload` when present.
  if ("payload" in parsed) {
    const payload = (parsed as { payload: unknown }).payload;
    if (typeof payload !== "object" || payload === null || !("op" in payload)) {
      throw new Error("Kafka Connect envelope has a payload but no `op` field");
    }
    return parsed as DebeziumEnvelope;
  }
  // Unwrapped form: the message IS the payload. Checking for `op`
  // specifically, not just "some object", so a genuinely malformed message
  // still fails loudly instead of being silently treated as a no-op change.
  if ("op" in parsed) {
    return { payload: parsed as DebeziumEnvelope["payload"] };
  }
  throw new Error("not a Debezium change event (no `payload` wrapper and no `op` field)");
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
