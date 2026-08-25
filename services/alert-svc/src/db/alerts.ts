// SVC-014/015/016 — REQ-5.4: alert triage (acknowledge/escalate/dismiss),
// all actions logged with operator ID + timestamp into a separate
// append-only table (alert_actions) rather than just overwriting
// alerts.status, so history survives a later status change.
import { eq, desc } from "drizzle-orm";
import { alerts, alertActions, type VektorDb } from "@vektor/db";
import type { AlertType, AlertSeverity } from "@vektor/shared";

export interface CreateAlertInput {
  type: AlertType;
  entity_id: string | null;
  severity: AlertSeverity;
  message: string;
}

export type AlertRow = typeof alerts.$inferSelect;

export async function createAlert(db: VektorDb, input: CreateAlertInput): Promise<AlertRow> {
  const [row] = await db.insert(alerts).values(input).returning();
  return row!;
}

export async function setDispatchLog(db: VektorDb, alertId: string, log: unknown[]): Promise<void> {
  await db.update(alerts).set({ dispatch_log: log }).where(eq(alerts.alert_id, alertId));
}

export async function listAlerts(db: VektorDb, limit = 100): Promise<AlertRow[]> {
  return db.select().from(alerts).orderBy(desc(alerts.ts)).limit(limit);
}

export async function getAlert(db: VektorDb, alertId: string): Promise<AlertRow | null> {
  const rows = await db.select().from(alerts).where(eq(alerts.alert_id, alertId)).limit(1);
  return rows[0] ?? null;
}

const ACTION_TO_STATUS = {
  ACKNOWLEDGE: "ACKNOWLEDGED",
  ESCALATE: "ESCALATED",
  DISMISS: "DISMISSED",
} as const;

export type AlertActionType = keyof typeof ACTION_TO_STATUS;

export async function applyAlertAction(
  db: VektorDb,
  alertId: string,
  action: AlertActionType,
  operatorId: string,
): Promise<AlertRow | null> {
  const existing = await getAlert(db, alertId);
  if (!existing) return null;

  const status = ACTION_TO_STATUS[action];
  const now = new Date();
  const [row] = await db
    .update(alerts)
    .set({
      status,
      ...(action === "ACKNOWLEDGE" ? { acknowledged_by: operatorId, acknowledged_at: now } : {}),
    })
    .where(eq(alerts.alert_id, alertId))
    .returning();

  await db.insert(alertActions).values({ alert_id: alertId, action, operator_id: operatorId });

  return row ?? null;
}
