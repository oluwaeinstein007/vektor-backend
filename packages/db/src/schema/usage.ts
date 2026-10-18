// packages/db/src/schema/usage.ts — NW-016.
//
// Rollups, not raw events. One row per (organisation, metric, hour) rather
// than one per observation: at PERF-001's measured 9,889 events/sec, a raw
// `ingest.events` table would take ~855M rows a day for a number nobody
// queries at that resolution. Hourly is the finest granularity any pricing
// model in 19-commercialization.md plausibly needs, and daily or monthly
// totals are a SUM over it.
//
// Attribution detail that does NOT survive the rollup (which API key,
// which sensor) lives on the Kafka event and in audit_log. That is the
// deliberate split: rollups answer "what do we bill", the log answers
// "why is that number what it is".
import { pgTable, pgPolicy, uuid, text, integer, bigint, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vektorAppRole } from "./auditLog.js";
import { DEFAULT_ORG_ID } from "./orgConstants.js";

export const usageRollups = pgTable(
  "usage_rollups",
  {
    org_id: uuid("org_id").notNull().default(DEFAULT_ORG_ID),
    metric: text("metric").notNull(),
    /** Start of the hour, UTC. The period is implied; storing an end too would be a second source of truth. */
    period_start: timestamp("period_start", { withTimezone: true }).notNull(),
    /**
     * bigint, not integer. `ingest.events` at the measured sustained rate
     * passes 2^31 in under three days for a single organisation, and a
     * silently wrapped counter is a billing error nobody would look for.
     */
    quantity: bigint("quantity", { mode: "bigint" }).notNull().default(0n),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.org_id, table.metric, table.period_start] }),
    pgPolicy("usage_rollups_org_isolation", {
      for: "all",
      to: vektorAppRole,
      using: sql`org_id = current_setting('vektor.org_id')::uuid`,
      withCheck: sql`org_id = current_setting('vektor.org_id')::uuid`,
    }),
  ],
).enableRLS();

/**
 * Per-partition consumer progress, written in the SAME transaction as the
 * rollup upsert it accounts for.
 *
 * This is what makes the rollup exactly-once rather than at-least-once.
 * Kafka's own offset commit happens after processing, so a crash in between
 * replays the batch — and because the rollup is `quantity = quantity +
 * excluded.quantity`, a replay DOUBLE-COUNTS. For a latency metric nobody
 * would care; for a number on an invoice it is the defect that destroys
 * trust in the whole subsystem. Committing the offset atomically with the
 * increment means a replayed batch is recognised and skipped.
 */
export const usageConsumerOffsets = pgTable(
  "usage_consumer_offsets",
  {
    topic: text("topic").notNull(),
    partition: integer("partition").notNull(),
    /** Highest offset already folded into the rollups, inclusive. */
    last_offset: bigint("last_offset", { mode: "bigint" }).notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.topic, table.partition] })],
);
