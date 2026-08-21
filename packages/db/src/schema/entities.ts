// packages/db/src/schema/entities.ts — VEKTOR-PRD.md §12.2.
// Storage-layer mapping for the canonical Entity contract (@vektor/proto).
// Column shape mirrors the Zod schema but is not generated from it: geometry
// and jsonb are storage concerns the wire contract doesn't need to encode.
import { pgTable, uuid, text, real, geometry, timestamp, jsonb } from "drizzle-orm/pg-core";

export const entities = pgTable("entities", {
  entity_id: uuid("entity_id").primaryKey().defaultRandom(),
  classification: text("classification").notNull(),
  confidence: real("confidence").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  affiliation: text("affiliation").notNull().default("UNKNOWN"),
  position: geometry("position", { type: "point", srid: 4326 }),
  kinematics: jsonb("kinematics"),
  metadata: jsonb("metadata"),
  first_detected: timestamp("first_detected").defaultNow(),
  last_updated: timestamp("last_updated").defaultNow(),
});
