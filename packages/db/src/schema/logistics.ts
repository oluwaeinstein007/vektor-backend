// packages/db/src/schema/logistics.ts — Phase 5, SVC-017/018. Storage layer
// for @vektor/proto's InventoryItem/InventoryForecast. inventory_history is
// append-only (one row per Debezium CDC event) and is the sole input to
// SVC-018's linear-regression forecaster — see logistics-svc/src/forecast.
import { pgTable, uuid, text, real, timestamp, boolean } from "drizzle-orm/pg-core";

export const inventoryItems = pgTable("inventory_items", {
  item_id: uuid("item_id").primaryKey(), // same UUID as the upstream ERP row — no VEKTOR-side identity of its own
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  quantity: real("quantity").notNull(),
  reorder_threshold: real("reorder_threshold").notNull(),
  location: text("location").notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const inventoryHistory = pgTable("inventory_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  item_id: uuid("item_id").notNull(),
  quantity: real("quantity").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
});

export const inventoryForecasts = pgTable("inventory_forecasts", {
  item_id: uuid("item_id").primaryKey(),
  quantity: real("quantity").notNull(),
  depletion_rate_per_hour: real("depletion_rate_per_hour").notNull(),
  hours_to_stockout: real("hours_to_stockout"),
  low_stock: boolean("low_stock").notNull().default(false),
  forecast_at: timestamp("forecast_at").defaultNow(),
});
