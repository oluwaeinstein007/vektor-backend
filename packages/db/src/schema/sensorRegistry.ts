// packages/db/src/schema/sensorRegistry.ts — REQ-1.8/Epic 8's
// `POST /api/v1/sensors` (never implemented until now). Same
// mapper-not-column-copy discipline as every other table: fusion-svc's
// mappers translate rows into the wire SensorRegistration/SensorHealth
// contracts, never `as`.
import { pgTable, text, real, geometry, timestamp } from "drizzle-orm/pg-core";

export const sensorRegistry = pgTable("sensor_registry", {
  // sensor_id is operator-assigned at the adapter config level (ingest-svc's
  // *_SENSOR_ID env vars) and reused verbatim here — a natural key, not a
  // generated uuid, since every domain schema (AisPositionReport, etc.)
  // already keys on this same string.
  sensor_id: text("sensor_id").primaryKey(),
  sensor_type: text("sensor_type").notNull(),
  label: text("label").notNull(),
  position: geometry("position", { type: "point", srid: 4326 }).notNull(),
  coverage_radius_m: real("coverage_radius_m").notNull(),
  registered_at: timestamp("registered_at").defaultNow(),
});
