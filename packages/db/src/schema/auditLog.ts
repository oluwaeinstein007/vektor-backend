// packages/db/src/schema/auditLog.ts — Phase 4, SVC-013, REQ-8.3.
// audit-svc is the only writer; every other service treats this table as
// insert-only.
//
// SEC-003: the append-only guarantee used to be enforced only by
// convention (audit-svc simply never implements an update/delete query).
// This adds a real, DB-level backstop: RLS policies on the `vektor_app`
// role that make UPDATE/DELETE always fail (`using: sql\`false\``),
// regardless of what a future bug in audit-svc's own code might attempt.
//
// Deployment gap this doesn't close by itself: RLS never applies to a
// table's owner or to a superuser connection (Postgres has no override for
// this), and every service's DATABASE_URL in this repo's dev/test config
// currently connects as the `postgres` superuser — so this policy is inert
// until each service's connection identity is actually switched to
// `vektor_app` (or an equivalent non-owner, non-superuser role) as part of
// a separate infra/secrets rollout. The policy itself is verified directly
// against a `vektor_app` connection in tests/rls.test.ts.
import { pgTable, pgPolicy, pgRole, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// `.existing()`: this role is provisioned once per Postgres cluster (a
// cluster-level object, not scoped to this database) — a real deployment
// creates it via the same infra/Vault-managed provisioning as any other
// service credential, not a per-migration DDL statement that would attempt
// to recreate it on every fresh environment. Tests create it locally
// instead (see tests/rls.test.ts) since no such provisioning step exists
// in this sandbox.
export const vektorAppRole = pgRole("vektor_app").existing();

export const auditLog = pgTable(
  "audit_log",
  {
    audit_id: uuid("audit_id").primaryKey().defaultRandom(),
    actor_user_id: text("actor_user_id").notNull(),
    actor_role: text("actor_role").notNull(),
    action: text("action").notNull(),
    resource_type: text("resource_type").notNull(),
    resource_id: text("resource_id"),
    metadata: jsonb("metadata").notNull().default({}),
    ts: timestamp("ts").defaultNow(),
  },
  (table) => [
    pgPolicy("audit_log_select_all", { for: "select", to: vektorAppRole, using: sql`true` }),
    pgPolicy("audit_log_insert_any", { for: "insert", to: vektorAppRole, withCheck: sql`true` }),
    // `using: false` (not merely "no policy") is deliberate: a FOR UPDATE/
    // DELETE policy that always evaluates false makes every such statement
    // affect zero rows for this role, even if it's later also granted the
    // UPDATE/DELETE table privilege by mistake — the append-only guarantee
    // doesn't depend on the GRANTs staying correct forever.
    pgPolicy("audit_log_no_update", { for: "update", to: vektorAppRole, using: sql`false` }),
    pgPolicy("audit_log_no_delete", { for: "delete", to: vektorAppRole, using: sql`false` }),
  ],
).enableRLS();
