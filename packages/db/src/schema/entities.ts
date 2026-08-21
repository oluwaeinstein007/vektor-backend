// packages/db/src/schema/entities.ts — VEKTOR-PRD.md §12.2.
// Storage-layer mapping for the canonical Entity contract (@vektor/proto).
// Column shape mirrors the Zod schema but is not generated from it: geometry
// and jsonb are storage concerns the wire contract doesn't need to encode.
//
// `position` only carries lon/lat (drizzle-orm's PgGeometry column only
// parses 2D EWKB points — see mapFromDriverValue in
// drizzle-orm/pg-core/columns/postgis_extension/utils.js, which throws on
// anything but a plain POINT). alt_m and accuracy_m are sensor-reported
// values with no natural home in a 2D point, so they're their own columns.
// mgrs is deliberately NOT stored — it's a pure function of lon/lat
// (see the `mgrs` package) and storing it would just be a second source of
// truth that could drift from the coordinates. The storage → wire `Entity`
// mapping (including the mgrs computation) lives in each consuming
// service — see services/geospatial-svc/src/mappers/entity.ts.
import { pgTable, uuid, text, real, geometry, timestamp, jsonb } from "drizzle-orm/pg-core";

export const entities = pgTable("entities", {
  entity_id: uuid("entity_id").primaryKey().defaultRandom(),
  classification: text("classification").notNull(),
  confidence: real("confidence").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  affiliation: text("affiliation").notNull().default("UNKNOWN"),
  source_sensors: text("source_sensors").array().notNull().default([]),
  position: geometry("position", { type: "point", srid: 4326 }),
  alt_m: real("alt_m").notNull().default(0),
  accuracy_m: real("accuracy_m").notNull().default(0),
  kinematics: jsonb("kinematics"),
  metadata: jsonb("metadata"),
  first_detected: timestamp("first_detected").defaultNow(),
  last_updated: timestamp("last_updated").defaultNow(),
});
