// packages/db/src/schema/auditLog.ts — Phase 4, SVC-013, REQ-8.3.
// audit-svc is the only writer; every other service treats this table as
// insert-only. No update/delete query exists anywhere in this codebase for
// this table — that's the append-only guarantee, enforced by convention
// (audit-svc simply never implements one) since Postgres itself has no
// built-in "insert-only" table privilege short of a REVOKE UPDATE/DELETE
// grant, which is applied at the infra/RBAC layer (SEC-003), not here.
import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const auditLog = pgTable("audit_log", {
  audit_id: uuid("audit_id").primaryKey().defaultRandom(),
  actor_user_id: text("actor_user_id").notNull(),
  actor_role: text("actor_role").notNull(),
  action: text("action").notNull(),
  resource_type: text("resource_type").notNull(),
  resource_id: text("resource_id"),
  metadata: jsonb("metadata").notNull().default({}),
  ts: timestamp("ts").defaultNow(),
});
