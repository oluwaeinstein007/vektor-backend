// SVC-018 — REQ-6.1 (recompute every 15 min) / REQ-6.3 (low-stock alert).
// index.ts's setInterval is the "every 15 min" half; this module is the
// pure recompute-and-persist step tests call directly rather than waiting
// on a real 15-minute clock (same split as fusion-svc's runPipelineOnce
// being called directly from tests instead of through its while-loop).
import { eq, sql } from "drizzle-orm";
import { inventoryItems, inventoryHistory, inventoryForecasts, alerts, type VektorDb } from "@vektor/db";
import { forecastDepletion, isLowStock } from "./regression.js";

export interface RecomputeOptions {
  leadTimeHours: number;
  onLowStock?: (itemId: string, message: string) => void;
}

export async function recomputeAllForecasts(db: VektorDb, options: RecomputeOptions): Promise<number> {
  const items = await db.select().from(inventoryItems);
  let count = 0;

  for (const item of items) {
    const history = await db
      .select({ ts: inventoryHistory.ts, quantity: inventoryHistory.quantity })
      .from(inventoryHistory)
      .where(eq(inventoryHistory.item_id, item.item_id));

    const { depletion_rate_per_hour, hours_to_stockout } = forecastDepletion(history);
    const lowStock = isLowStock(item.quantity, item.reorder_threshold, hours_to_stockout, options.leadTimeHours);

    const wasLowStock = await isPreviouslyLowStock(db, item.item_id);

    await db
      .insert(inventoryForecasts)
      .values({
        item_id: item.item_id,
        quantity: item.quantity,
        depletion_rate_per_hour,
        hours_to_stockout,
        low_stock: lowStock,
      })
      .onConflictDoUpdate({
        target: inventoryForecasts.item_id,
        set: {
          quantity: item.quantity,
          depletion_rate_per_hour,
          hours_to_stockout,
          low_stock: lowStock,
          forecast_at: new Date(),
        },
      });

    // Only fire on the low-stock *transition* (REQ-6.3's "alert fires at
    // configurable lead-time threshold") — re-alerting every 15-minute
    // recompute for an item that's been low for hours would flood the
    // triage queue (REQ-5.4) with duplicates of the same fact.
    if (lowStock && !wasLowStock) {
      const message = `Inventory item ${item.sku} (${item.name}) at ${item.location} is low: ${item.quantity} units, ${
        hours_to_stockout !== null ? `${hours_to_stockout.toFixed(1)}h to stockout` : "below reorder threshold"
      }`;
      await db.insert(alerts).values({ type: "LOW_STOCK", entity_id: null, severity: "MEDIUM", message });
      options.onLowStock?.(item.item_id, message);
    }

    count++;
  }

  return count;
}

async function isPreviouslyLowStock(db: VektorDb, itemId: string): Promise<boolean> {
  const rows = await db.execute<{ low_stock: boolean }>(
    sql`SELECT low_stock FROM inventory_forecasts WHERE item_id = ${itemId} LIMIT 1`,
  );
  return Boolean(rows[0]?.low_stock);
}
