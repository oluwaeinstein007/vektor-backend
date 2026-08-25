// packages/db/src/schema/geofence.ts — Phase 5, SVC-014/015/016. Storage
// layer for @vektor/proto's GeofenceZone and Alert contracts. `geom` reuses
// the customType pattern from blueForce.ts's no_strike_zones — drizzle-orm's
// built-in geometry() helper is point-only, see that file's comment.
import { pgTable, uuid, text, boolean, jsonb, timestamp, customType } from "drizzle-orm/pg-core";

const geometryPolygon = customType<{ data: string }>({
  dataType() {
    return "geometry(polygon)";
  },
});

export const geofenceZones = pgTable("geofence_zones", {
  zone_id: uuid("zone_id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  trigger: text("trigger").notNull(), // ENTRY | EXIT | BOTH
  severity: text("severity").notNull(), // LOW | MEDIUM | HIGH | CRITICAL
  affiliation_filter: text("affiliation_filter"), // null = any affiliation
  channels: jsonb("channels").notNull(), // AlertChannel[]
  notify: jsonb("notify").notNull(), // NotifyConfig
  geom: geometryPolygon("geom").notNull(),
  active: boolean("active").notNull().default(true),
  created_at: timestamp("created_at").defaultNow(),
});

export const alerts = pgTable("alerts", {
  alert_id: uuid("alert_id").primaryKey().defaultRandom(),
  type: text("type").notNull(), // GEOFENCE | ANOMALY | ESCALATION | SENSOR_HEALTH
  entity_id: uuid("entity_id"),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("OPEN"),
  dispatch_log: jsonb("dispatch_log").notNull().default([]), // per-channel delivery results
  ts: timestamp("ts").defaultNow(),
  acknowledged_by: text("acknowledged_by"),
  acknowledged_at: timestamp("acknowledged_at"),
});

// REQ-5.4: "all alert actions logged with operator ID and timestamp" — a
// separate append-only table (not just overwriting alerts.status) so the
// full ack/escalate/dismiss history survives even if the alert's current
// status is later changed again.
export const alertActions = pgTable("alert_actions", {
  action_id: uuid("action_id").primaryKey().defaultRandom(),
  alert_id: uuid("alert_id").notNull(),
  action: text("action").notNull(), // ACKNOWLEDGE | ESCALATE | DISMISS
  operator_id: text("operator_id").notNull(),
  ts: timestamp("ts").defaultNow(),
});
