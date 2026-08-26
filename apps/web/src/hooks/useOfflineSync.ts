"use client";

import { useCallback, useEffect, useState } from "react";
import { openSyncDb, queuePendingAction, listPendingActions, flushPendingActions, type PendingAction } from "@/lib/offline-sync";

/**
 * FE side of EDGE-005. `queueOrSend` tries a live POST first (the common
 * case — connected); only on a real network failure does the action fall
 * back to the IndexedDB queue, matching `navigator.onLine`'s own
 * unreliability (it can read true while the field connection is actually
 * down) with an actual failed-request signal instead.
 */
export function useOfflineSync(syncIntakeUrl: string) {
  const [pendingCount, setPendingCount] = useState(0);

  const refreshCount = useCallback(async () => {
    const db = await openSyncDb();
    setPendingCount((await listPendingActions(db)).length);
  }, []);

  const flush = useCallback(async () => {
    const db = await openSyncDb();
    await flushPendingActions(db, syncIntakeUrl);
    await refreshCount();
  }, [syncIntakeUrl, refreshCount]);

  useEffect(() => {
    void refreshCount();
    void flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [flush, refreshCount]);

  const queueOrSend = useCallback(
    async (action: PendingAction) => {
      try {
        const res = await fetch(syncIntakeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action),
        });
        if (res.ok) return { queued: false as const };
      } catch {
        // fall through to queueing below
      }
      const db = await openSyncDb();
      await queuePendingAction(db, action);
      await refreshCount();
      return { queued: true as const };
    },
    [syncIntakeUrl, refreshCount],
  );

  return { pendingCount, queueOrSend, flush };
}
