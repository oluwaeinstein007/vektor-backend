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