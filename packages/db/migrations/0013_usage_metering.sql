-- NW-016: usage metering rollups.
--
-- HAND-WRITTEN for the RLS policy's `current_setting()` predicate.
--
-- Numbered 0013, not 0010. The 0010 slot was reserved for this migration
-- by a concurrent session that ended before writing it, while NW-015 and
-- NW-017 went out as 0011 and 0012. Taking 0010 now would mean a migration
-- that applies AFTER two higher-numbered ones already in the database —
-- `drizzle-kit migrate` orders by the journal, not the filename, so it
-- would work and would be a trap for every later reader. The 0010 gap is
-- therefore permanent and means nothing was ever numbered 0010.
--
-- Depends on 0011 for the `organisations` foreign key.

CREATE TABLE IF NOT EXISTS "usage_rollups" (
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"metric" text NOT NULL,
	"period_start" timestamptz NOT NULL,
	-- bigint: `ingest.events` at PERF-001's sustained 9,889/sec passes 2^31
	-- in under three days for ONE organisation. A wrapped counter is a
	-- billing error nobody thinks to look for.
	"quantity" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "usage_rollups_pk" PRIMARY KEY ("org_id", "metric", "period_start")
);
--> statement-breakpoint

-- Exactly-once bookkeeping for the rollup consumer. Written in the same
-- transaction as the increment it accounts for; see schema/usage.ts.
CREATE TABLE IF NOT EXISTS "usage_consumer_offsets" (
	"topic" text NOT NULL,
	"partition" integer NOT NULL,
	"last_offset" bigint NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "usage_consumer_offsets_pk" PRIMARY KEY ("topic", "partition")
);
--> statement-breakpoint

-- Defensive: `organisations` exists only once 0011 has run, and this
-- migration's idx places it after. Guarding on the table's existence keeps
-- a partial or out-of-order application from failing here rather than
-- producing an unreferenced column.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organisations')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'usage_rollups_org_id_fk') THEN
    ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organisations"("org_id");
  END IF;
END
$$;--> statement-breakpoint

-- "This organisation's usage for a billing period" — the one query that
-- matters, and the shape an invoice is built from.
CREATE INDEX IF NOT EXISTS "usage_rollups_org_period_idx"
  ON "usage_rollups" ("org_id", "period_start");--> statement-breakpoint

ALTER TABLE "usage_rollups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "usage_rollups_org_isolation" ON "usage_rollups";--> statement-breakpoint
CREATE POLICY "usage_rollups_org_isolation" ON "usage_rollups" AS PERMISSIVE FOR ALL TO "vektor_app"
  USING (org_id = current_setting('vektor.org_id')::uuid)
  WITH CHECK (org_id = current_setting('vektor.org_id')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "usage_rollups" TO "vektor_app";--> statement-breakpoint

-- No DELETE grant and no RLS on usage_consumer_offsets: it is the rollup
-- consumer's own bookkeeping, not tenant data, and it is written by the
-- owner connection. Deleting a usage rollup is not something an
-- application role should be able to do at all — it is the record a bill
-- is built from.
GRANT SELECT, INSERT, UPDATE ON "usage_consumer_offsets" TO "vektor_app";
