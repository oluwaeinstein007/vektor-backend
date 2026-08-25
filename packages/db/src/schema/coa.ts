// packages/db/src/schema/coa.ts — Phase 4, SVC-013. Storage layer for
// @vektor/proto's COA contract. `options` is stored as jsonb (an array of
// COAOption) rather than a child table — a COA's options are immutable once
// generated (only `selected_option`/`status`/`commander_notes` are ever
// updated by the approve/reject workflow), so there's no query that needs to
// filter/join on a single option's fields independently of its parent COA.
import { pgTable, uuid, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

export const coas = pgTable("coas", {
  coa_id: uuid("coa_id").primaryKey().defaultRandom(),
  situation_id: uuid("situation_id").notNull(),
  options: jsonb("options").notNull(),
  selected_option: integer("selected_option"),
  commander_notes: text("commander_notes"),
  status: text("status").notNull().default("PENDING"),
  generated_at: timestamp("generated_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});
