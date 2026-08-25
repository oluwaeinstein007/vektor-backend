import { AuditEntry } from "@vektor/shared";
import type { auditLog } from "@vektor/db";

type AuditLogRow = typeof auditLog.$inferSelect;

export function toWireAuditEntry(row: AuditLogRow): AuditEntry {
  return AuditEntry.parse({
    audit_id: row.audit_id,
    actor_user_id: row.actor_user_id,
    actor_role: row.actor_role,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    metadata: row.metadata,
    ts: new Date(row.ts ?? Date.now()).toISOString(),
  });
}
