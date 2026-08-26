// EDGE-005 (UC-4.2: "Submit a spot report [action] that queues for sync on
// reconnect"): an operator write action taken while `navigator.onLine` is
// false gets persisted in IndexedDB rather than lost, and drains to
// edge-sync-svc's real POST /sync/intake (services/edge-sync-svc/src/routes/
// sync.ts) once connectivity returns. The wire shape here matches that
// route's IntakeJob schema exactly (services/edge-sync-svc/src/queue/
// intakeQueue.ts) — not re-declared from a shared package because it's one
// specific service's HTTP request body, not a cross-cutting domain
// contract; same line vektor-build-conventions already draws for
// edge-sync-svc's own EntityUpsertedMessage.
import { openDB, type IDBPDatabase } from "idb";

export interface PendingAlertAckAction {
  kind: "alert-ack";
  alert_id: string;
  action: "ACKNOWLEDGE" | "ESCALATE" | "DISMISS";
  operator_id: string;
  client_ts: string;
}

export type PendingAction = PendingAlertAckAction;

interface PendingActionRow extends PendingAction {
  id: number;
}

const DB_NAME = "vektor-offline-sync";
const STORE_NAME = "pending-actions";

export function openSyncDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    },
  });
}

export async function queuePendingAction(db: IDBPDatabase, action: PendingAction): Promise<number> {
  return db.add(STORE_NAME, action) as Promise<number>;
}

export async function listPendingActions(db: IDBPDatabase): Promise<PendingActionRow[]> {
  return db.getAll(STORE_NAME) as Promise<PendingActionRow[]>;
}

export async function removePendingAction(db: IDBPDatabase, id: number): Promise<void> {
  await db.delete(STORE_NAME, id);
}

export interface FlushResult {
  synced: number;
  remaining: number;
}

/**
 * Drains every queued action to edge-sync-svc's intake endpoint, one at a
 * time, removing each only after a real 2xx response — a mid-drain
 * connectivity blip just leaves the rest queued for the next flush rather
 * than losing them.
 */
export async function flushPendingActions(db: IDBPDatabase, syncIntakeUrl: string): Promise<FlushResult> {
  const rows = await listPendingActions(db);
  let synced = 0;

  for (const row of rows) {
    const { id, ...action } = row;
    try {
      const res = await fetch(syncIntakeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action),
      });
      if (!res.ok) break; // stop draining on first failure — preserves order, avoids hammering a still-down endpoint
      await removePendingAction(db, id);
      synced += 1;
    } catch {
      break; // still offline (or edge-sync-svc unreachable) — leave the rest queued
    }
  }

  const remaining = (await listPendingActions(db)).length;
  return { synced, remaining };
}
