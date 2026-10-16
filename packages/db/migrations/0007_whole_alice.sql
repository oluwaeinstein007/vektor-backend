-- NW-003/NW-009: create the role this migration grants to.
--
-- Everything below GRANTs to `vektor_app`, but nothing in the repo ever
-- created it — the only place it got created was
-- packages/db/tests/rls.test.ts, at test time. `drizzle-kit migrate`
-- against a genuinely empty database therefore failed right here with
-- `role "vektor_app" does not exist`. A compose init script was the first
-- fix, but that only helps people using this repo's own dev stack; a plain
-- migrate against any other fresh database still broke. It belongs in the
-- migration.
--
-- Postgres has no `CREATE ROLE IF NOT EXISTS`, hence the DO block. NOLOGIN
-- and no password on purpose: this creates the *grant target* only. A real
-- deployment gives it LOGIN and a credential through Vault (INFRA-010), and
-- the dev stack does so in compose/postgres-init/01-vektor-app-role.sql.
-- See ADR-0011 for why RLS on audit_log is defence-in-depth rather than the
-- primary control.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vektor_app') THEN
    CREATE ROLE vektor_app NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_log_select_all" ON "audit_log" AS PERMISSIVE FOR SELECT TO "vektor_app" USING (true);--> statement-breakpoint
CREATE POLICY "audit_log_insert_any" ON "audit_log" AS PERMISSIVE FOR INSERT TO "vektor_app" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "audit_log_no_update" ON "audit_log" AS PERMISSIVE FOR UPDATE TO "vektor_app" USING (false);--> statement-breakpoint
CREATE POLICY "audit_log_no_delete" ON "audit_log" AS PERMISSIVE FOR DELETE TO "vektor_app" USING (false);--> statement-breakpoint
-- Not expressible via drizzle-kit's schema DSL (no grant() helper) — a
-- policy only restricts *which rows* a permitted operation touches, it
-- doesn't grant the operation itself. Without these, `vektor_app` couldn't
-- SELECT/INSERT at all, policies or not; UPDATE/DELETE deliberately get NO
-- grant here on top of their always-false policy — belt and suspenders.
GRANT SELECT, INSERT ON "audit_log" TO "vektor_app";