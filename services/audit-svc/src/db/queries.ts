// Genuinely append-only by omission: this is the only query file in the
// service, and it has no update/delete export. A hard guarantee (REVOKE
// UPDATE/DELETE at the Postgres role level) is SEC-003's job — see README.
import { and, gte, lte, eq, desc } from "drizzle-orm";
import { auditLog, type VektorDb } from "@vektor/db";

export interface InsertAuditEntryParams {
  actor_user_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata?: Record<string, unknown>;
}

export async function insertAuditEntry(db: VektorDb, params: InsertAuditEntryParams) {
  const [row] = await db
    .insert(auditLog)
    .values({
      actor_user_id: params.actor_user_id,
      actor_role: params.actor_role,
      action: params.action,
      resource_type: params.resource_type,
      resource_id: params.resource_id,
      metadata: params.metadata ?? {},
    })
    .returning();
  if (!row) throw new Error("insertAuditEntry: insert returned no row");
  return row;
}

export interface ListAuditEntriesFilters {
  actor_user_id?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listAuditEntries(db: VektorDb, filters: ListAuditEntriesFilters) {
  const conditions = [];
  if (filters.actor_user_id) conditions.push(eq(auditLog.actor_user_id, filters.actor_user_id));
  if (filters.action) conditions.push(eq(auditLog.action, filters.action));
  if (filters.from) conditions.push(gte(auditLog.ts, filters.from));
  if (filters.to) conditions.push(lte(auditLog.ts, filters.to));

  return db.query.auditLog.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: desc(auditLog.ts),
    limit: Math.min(filters.limit ?? 100, 1000),
  });
}
