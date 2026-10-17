-- NW-018 (UC-2.2): entity_history — the time-indexed projection of the
-- durable `{env}.vektor.entities.upserted` topic.
--
-- HAND-WRITTEN, not generated. `drizzle-kit generate` cannot express
-- declarative partitioning, so regenerating this migration would silently
-- drop the PARTITION BY clause and produce an unpartitioned table that
-- works fine until retention matters and then cannot be cleaned up without
-- a mass DELETE. See packages/db/src/schema/entityHistory.ts.

CREATE TABLE "entity_history" (
	"entity_id" uuid NOT NULL,
	"ts" timestamptz NOT NULL,
	"position" geometry(point, 4326) NOT NULL,
	"alt_m" real DEFAULT 0 NOT NULL,
	"speed_kmh" real DEFAULT 0 NOT NULL,
	"heading_deg" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"classification" text NOT NULL,
	"affiliation" text NOT NULL,
	"status" text NOT NULL,
	-- A partitioned table's unique constraint MUST contain the partition
	-- key, which `ts` is. That is not a workaround — it is what makes the
	-- projector idempotent: replaying the Kafka topic (a backfill, a
	-- consumer-group reset) re-inserts identical (entity_id, ts) rows, and
	-- ON CONFLICT DO NOTHING makes that a no-op instead of silently
	-- doubling every track.
	CONSTRAINT "entity_history_entity_ts_uniq" UNIQUE ("entity_id", "ts")
) PARTITION BY RANGE ("ts");
--> statement-breakpoint

-- Supports the snapshot query (every entity's last row at or before an
-- instant). The unique constraint above already provides the (entity_id,
-- ts) index the per-entity track query needs.
CREATE INDEX "entity_history_ts_idx" ON "entity_history" USING btree ("ts");
--> statement-breakpoint

-- Creates one day's partition if it is missing. Called by the projector
-- before each insert (it caches which days it has ensured, so this is one
-- round-trip per new day, not per row).
--
-- There is deliberately NO DEFAULT partition. A default partition would
-- make a write for an un-ensured day succeed quietly, and rows sitting in
-- it then BLOCK creating that day's real partition later — a trap that
-- only springs weeks after the mistake. Without one, such a write fails
-- loudly, the Kafka consumer does not commit its offset, and the event is
-- redelivered: recoverable, and visible immediately.
CREATE OR REPLACE FUNCTION ensure_entity_history_partition(day date)
RETURNS void AS $$
DECLARE
	partition_name text := 'entity_history_' || to_char(day, 'YYYYMMDD');
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = partition_name) THEN
		EXECUTE format(
			'CREATE TABLE %I PARTITION OF entity_history FOR VALUES FROM (%L) TO (%L)',
			partition_name, day, day + 1
		);
	END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Retention (NW-018's configurable window, default 7 days). DROPping whole
-- day partitions is near-instant and returns the disk immediately; the
-- DELETE this replaces would walk hundreds of millions of rows and leave
-- the table bloated until a VACUUM FULL.
CREATE OR REPLACE FUNCTION drop_entity_history_partitions_before(cutoff date)
RETURNS integer AS $$
DECLARE
	partition_record record;
	dropped integer := 0;
BEGIN
	FOR partition_record IN
		SELECT c.relname
		FROM pg_class c
		JOIN pg_inherits i ON i.inhrelid = c.oid
		JOIN pg_class parent ON parent.oid = i.inhparent
		WHERE parent.relname = 'entity_history'
		  AND c.relname ~ '^entity_history_[0-9]{8}$'
		  AND to_date(right(c.relname, 8), 'YYYYMMDD') < cutoff
	LOOP
		EXECUTE format('DROP TABLE %I', partition_record.relname);
		dropped := dropped + 1;
	END LOOP;
	RETURN dropped;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Today and tomorrow, so a freshly migrated database can accept writes
-- immediately rather than depending on the projector's first ensure call.
SELECT ensure_entity_history_partition(CURRENT_DATE);
--> statement-breakpoint
SELECT ensure_entity_history_partition(CURRENT_DATE + 1);
