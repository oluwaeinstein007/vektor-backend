// Real Postgres: seeds inventory_items/inventory_history rows directly
// (bypassing CDC — that path is proven separately in cdc.integration.test.ts)
// to exercise SVC-018's recompute-and-persist step and REQ-6.3's
// fire-once-on-transition low-stock alert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql as sqlTag } from "drizzle-orm";
import { createDb, inventoryItems, inventoryHistory, inventoryForecasts, alerts } from "@vektor/db";
import { recomputeAllForecasts } from "../src/forecast/recompute.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

test("recomputeAllForecasts: persists a forecast and fires exactly one LOW_STOCK alert on the transition", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const itemId = randomUUID();
  const sku = `SKU-RECOMPUTE-${itemId}`;

  await db.insert(inventoryItems).values({
    item_id: itemId,
    sku,
    name: "Recompute Test Item",
    category: "TEST",
    quantity: 20,
    reorder_threshold: 15,
    location: "FOB-TEST",
    updated_at: new Date(),
  });

  // Declining history: 100 -> 20 over 8 hours (10/hr), well within a 24h lead time.
  await db.insert(inventoryHistory).values([
    { id: randomUUID(), item_id: itemId, quantity: 100, ts: hoursAgo(8) },
    { id: randomUUID(), item_id: itemId, quantity: 60, ts: hoursAgo(4) },
    { id: randomUUID(), item_id: itemId, quantity: 20, ts: hoursAgo(0) },
  ]);

  // recomputeAllForecasts processes every row in inventory_items, including
  // whatever other tests/manual runs have left behind — so every assertion
  // below is scoped to this test's own itemId rather than the raw fired
  // count, which would be cross-contaminated by an unrelated item
  // transitioning low-stock in the same pass (found 2026-08-25: a leftover
  // fixture item from cdc.integration.test.ts did exactly this).
  const lowStockFired: string[] = [];
  try {
    await recomputeAllForecasts(db, { leadTimeHours: 24, onLowStock: (id) => lowStockFired.push(id) });

    const [forecast] = await db.select().from(inventoryForecasts).where(eq(inventoryForecasts.item_id, itemId)).limit(1);
    assert.ok(forecast);
    assert.equal(forecast.low_stock, true);
    assert.ok(forecast.hours_to_stockout !== null && forecast.hours_to_stockout < 24);
    assert.equal(
      lowStockFired.filter((id) => id === itemId).length,
      1,
    );

    const alertRows = await db.execute<{ message: string }>(
      sqlTag`SELECT message FROM alerts WHERE type = 'LOW_STOCK' AND message LIKE ${"%" + sku + "%"}`,
    );
    assert.equal(alertRows.length, 1);

    // Re-running the recompute with the same still-low state must NOT
    // fire a second alert for THIS item (REQ-6.3's transition-only semantics).
    await recomputeAllForecasts(db, { leadTimeHours: 24, onLowStock: (id) => lowStockFired.push(id) });
    assert.equal(
      lowStockFired.filter((id) => id === itemId).length,
      1,
    );
  } finally {
    await db.delete(inventoryForecasts).where(eq(inventoryForecasts.item_id, itemId));
    await db.delete(inventoryHistory).where(eq(inventoryHistory.item_id, itemId));
    await db.delete(inventoryItems).where(eq(inventoryItems.item_id, itemId));
    await db.execute(sqlTag`DELETE FROM alerts WHERE type = 'LOW_STOCK' AND message LIKE ${"%" + sku + "%"}`);
  }
});
