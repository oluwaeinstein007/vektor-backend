// packages/db/src/schema/entityHistory.ts — NW-018 (UC-2.2, historical
// playback and pattern-of-life).
//
// Why this table has to exist at all: `entities` is current-state only —
// one row per entity, `last_updated` overwritten in place — so "where was
// this entity at 14:12" is not answerable from it. The durable
// `{env}.vektor.entities.upserted` topic holds the whole sequence, but
// Kafka answers "replay this partition", not "this entity, between these
// two times". This table is that topic projected into something indexable.
//
// Written by geospatial-svc's history projector (a Kafka consumer, not the
// hot write path — see services/geospatial-svc/src/history/writer.ts), so
// it can be rebuilt from the topic at any time and never adds latency to
// the real-time sensor→operator leg.
//
// PARTITIONING: this is a declaratively RANGE-partitioned table, by day on
// `ts`. Drizzle has no DDL support for partitioning, so the partitioning
// clause lives in the migration (0009) and this definition describes only
// the shape — `drizzle-kit generate` would emit a plain CREATE TABLE and
// must not be allowed to regenerate this one. Retention is a matter of
// DROPping whole day partitions, which is near-instant, instead of a DELETE
// across hundreds of millions of rows that leaves the table bloated.
//
// Deliberately NOT TimescaleDB, despite §06-hardware's storage table and
// INFRA-005's task text both naming it: no hypertable has ever existed in
// this package, and the image every environment actually runs
// (postgis/postgis:16-3.4-alpine) carries no timescaledb extension.
// Adopting it would mean changing the base image everywhere, which is a
// bigger decision than this feature gets to make. Native partitioning is
// the 90% of the benefit that needs no new extension; Timescale remains the
// upgrade path if ingest volume ever demands it.
import { pgTable, uuid, text, real, geometry, timestamp, index } from "drizzle-orm/pg-core";

export const entityHistory = pgTable(
  "entity_history",
  {
    entity_id: uuid("entity_id").notNull(),
    // Observation time, not write time. The projector takes this from the
    // event's own last_updated so a replayed or backfilled topic produces
    // the same history as a live one — a write-time column would make
    // every backfill collapse into the moment the backfill ran.
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    position: geometry("position", { type: "point", srid: 4326 }).notNull(),
    alt_m: real("alt_m").notNull().default(0),
    speed_kmh: real("speed_kmh").notNull().default(0),
    heading_deg: real("heading_deg").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    // Denormalised from the entity so a track query needs no join: these
    // can change over an entity's life (a contact reclassified from UNKNOWN
    // to HOSTILE), and the history should show what was believed at the
    // time rather than retroactively rewriting it to today's view.
    classification: text("classification").notNull(),
    affiliation: text("affiliation").notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    // The track query: one entity, a time range, in time order. Leading on
    // entity_id and then ts is what makes that an index range scan rather
    // than a partition-wide sort.
    index("entity_history_entity_ts_idx").on(table.entity_id, table.ts),
    // The snapshot query: every entity's last row at or before an instant.
    // Partition pruning narrows it to a day; this orders within it.
    index("entity_history_ts_idx").on(table.ts),
  ],
);
