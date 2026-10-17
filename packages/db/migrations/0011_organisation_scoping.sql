-- NW-015: organisation scoping.
--
-- HAND-WRITTEN, not generated, for two reasons drizzle-kit cannot express:
--   1. the seed row for the default organisation, which every backfilled
--      `org_id` points at and which must exist BEFORE the foreign keys are
--      added; and
--   2. the RLS policies' `current_setting()` predicate.
-- Regenerating this would drop both and leave fifteen unenforced columns.
--
-- WHAT THIS DOES NOT DO: it does not make VEKTOR multi-tenant, and it does
-- not decide whether VEKTOR should be. 17-next-work.md is explicit that
-- staying single-tenant may be the right call. This migration is a no-op
-- for a single-tenant deployment — one organisation exists, every row
-- defaults to it, every existing query returns exactly what it did before
-- — and it removes the expensive half of the decision, which is
-- retrofitting a tenant key onto fifteen tables that already hold data.
--
-- ORDERING: seed the organisation, then add columns (defaulted, so the
-- backfill is implicit), then the FKs, then the indexes, then RLS. Adding a
-- FK before the referenced row exists fails; adding RLS before the columns
-- exist fails.

CREATE TABLE IF NOT EXISTS "organisations" (
	"org_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE ("slug")
);
--> statement-breakpoint

-- The organisation every pre-NW-015 row belongs to. The uuid is fixed, not
-- generated: a generated default would give the same logical row a
-- different org_id in dev and in production, which breaks fixtures, any
-- backup restored across environments, and any support query that quotes
-- an id. ON CONFLICT so re-running against a partially migrated database
-- is safe.
INSERT INTO "organisations" ("org_id", "slug", "name")
VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default Organisation')
ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint

-- Every tenant-scoped table gets the column, NOT NULL with the default, so
-- existing rows backfill without an UPDATE pass and existing INSERTs that
-- never mention org_id keep working unchanged. That is what makes this
-- migration a no-op for single-tenant.
--
-- `entity_history` is RANGE-partitioned; ALTER TABLE on the parent
-- propagates to every existing partition and to any created later by
-- ensure_entity_history_partition(). It is included deliberately: a
-- history table without a tenant key is a replay of another tenant's
-- movements, which is the worst of the fifteen to get wrong.
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "entity_history" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "blue_force_assets" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "no_strike_zones" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "geofence_zones" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_actions" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "coas" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "sensor_registry" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_history" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_forecasts" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL;--> statement-breakpoint

-- Foreign keys are declared here rather than via drizzle's `.references()`
-- because `organisations.ts` already imports `vektorAppRole` from
-- `auditLog.ts` for its policies; having `auditLog.ts` import
-- `organisations.ts` back would close an import cycle that ES modules
-- resolve to `undefined` at evaluation time, silently turning every
-- `.default(DEFAULT_ORG_ID)` into `.default(undefined)`. See
-- schema/orgConstants.ts.
--
-- No ON DELETE CASCADE anywhere, deliberately. Deleting an organisation
-- must not be a one-statement way to destroy a tenant's audit log; the
-- `status` column exists so an organisation can be suspended instead, and
-- an actual deletion has to confront each table on purpose.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities','blue_force_assets','no_strike_zones','geofence_zones','alerts',
    'alert_actions','coas','reports','report_schedules','sensor_registry',
    'inventory_items','inventory_history','inventory_forecasts','audit_log'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = t || '_org_id_fk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (org_id) REFERENCES organisations(org_id)',
        t, t || '_org_id_fk'
      );
    END IF;
  END LOOP;
END
$$;--> statement-breakpoint

-- entity_history is deliberately NOT in the loop above: Postgres rejects a
-- foreign key on a partitioned table's parent only in older versions, but
-- more to the point, the FK would be re-validated against every partition
-- on every ATTACH, which is a per-day cost on the hot projector path for a
-- guarantee the writer already provides (it copies org_id from the entity
-- it is projecting). The column, the index and the RLS policy all apply;
-- only the referential constraint is omitted, and this comment is here so
-- that reads as a decision rather than an oversight.

-- Scoped lookups all filter by org_id first, so it leads every index.
-- Partial-index alternatives were rejected: they would need one index per
-- organisation, which does not survive the first tenant being added.
CREATE INDEX IF NOT EXISTS "entities_org_idx" ON "entities" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_history_org_ts_idx" ON "entity_history" ("org_id", "ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blue_force_assets_org_idx" ON "blue_force_assets" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "no_strike_zones_org_idx" ON "no_strike_zones" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "geofence_zones_org_idx" ON "geofence_zones" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_org_idx" ON "alerts" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_actions_org_idx" ON "alert_actions" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coas_org_idx" ON "coas" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_org_idx" ON "reports" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_schedules_org_idx" ON "report_schedules" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sensor_registry_org_idx" ON "sensor_registry" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_items_org_idx" ON "inventory_items" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_history_org_idx" ON "inventory_history" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inventory_forecasts_org_idx" ON "inventory_forecasts" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_org_idx" ON "audit_log" ("org_id");--> statement-breakpoint

-- RLS. Read schema/auditLog.ts's header before changing any of this: these
-- policies are scoped `TO vektor_app`, and Postgres never applies RLS to a
-- table's owner or to a superuser. Every DATABASE_URL in this repo's
-- dev/test config connects as `postgres`, so **these policies are inert
-- today** — exactly as SEC-003's audit_log policies have been since 0007.
-- That is deliberate and is what makes this migration safe to apply to a
-- running single-tenant system: nothing changes until a deployment
-- switches service connection identities to `vektor_app`, which is an
-- infra/secrets rollout (INFRA-010), not a migration.
--
-- `current_setting('vektor.org_id')` is called WITHOUT the `missing_ok`
-- second argument on purpose. Unset, it raises; it does not return NULL.
-- The NULL form would make every unscoped query return zero rows, which is
-- indistinguishable from "this organisation has no data" and is the
-- version of this bug that reaches production. packages/db/src/orgScope.ts
-- is the only supported way to set it, and it uses set_config(..., true)
-- so the value is transaction-local and cannot leak across a pooled
-- connection.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'entities','entity_history','blue_force_assets','no_strike_zones','geofence_zones',
    'alerts','alert_actions','coas','reports','report_schedules','sensor_registry',
    'inventory_items','inventory_history','inventory_forecasts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_org_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL TO "vektor_app" '
      'USING (org_id = current_setting(''vektor.org_id'')::uuid) '
      'WITH CHECK (org_id = current_setting(''vektor.org_id'')::uuid)',
      t || '_org_isolation', t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO "vektor_app"', t);
  END LOOP;
END
$$;--> statement-breakpoint

-- audit_log is handled separately because 0007 already gave it four
-- policies encoding the append-only guarantee, and policies on one table
-- are OR-ed together for a given command: adding a permissive FOR ALL
-- policy here would OR with `audit_log_no_update`/`no_delete` and silently
-- restore the ability to tamper with the audit trail. The append-only
-- policies are replaced in place with org-scoped equivalents instead, so
-- both guarantees hold at once.
DROP POLICY IF EXISTS "audit_log_select_all" ON "audit_log";--> statement-breakpoint
DROP POLICY IF EXISTS "audit_log_insert_any" ON "audit_log";--> statement-breakpoint
CREATE POLICY "audit_log_select_own_org" ON "audit_log" AS PERMISSIVE FOR SELECT TO "vektor_app"
  USING (org_id = current_setting('vektor.org_id')::uuid);--> statement-breakpoint
CREATE POLICY "audit_log_insert_own_org" ON "audit_log" AS PERMISSIVE FOR INSERT TO "vektor_app"
  WITH CHECK (org_id = current_setting('vektor.org_id')::uuid);--> statement-breakpoint

-- The organisation directory itself: readable by any scoped connection (a
-- service resolves its own org's name and status), never writable by one.
-- Provisioning an organisation is a control-plane action.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organisations_select_all" ON "organisations";--> statement-breakpoint
CREATE POLICY "organisations_select_all" ON "organisations" AS PERMISSIVE FOR SELECT TO "vektor_app" USING (true);--> statement-breakpoint
CREATE POLICY "organisations_no_insert" ON "organisations" AS PERMISSIVE FOR INSERT TO "vektor_app" WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "organisations_no_update" ON "organisations" AS PERMISSIVE FOR UPDATE TO "vektor_app" USING (false);--> statement-breakpoint
CREATE POLICY "organisations_no_delete" ON "organisations" AS PERMISSIVE FOR DELETE TO "vektor_app" USING (false);--> statement-breakpoint
GRANT SELECT ON "organisations" TO "vektor_app";
