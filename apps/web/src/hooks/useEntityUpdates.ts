"use client";

import { useEffect } from "react";
import { useVektorSocket } from "@/lib/socket-provider";
import { onValidated } from "@/lib/socket-client";
import { useEntityStore } from "@/stores/entity-store";

/** FE-002: keeps useEntityStore in sync with entity:new/updated/lost. */
export function useEntityUpdates(onInvalid?: (event: string, error: unknown) => void) {
  const socket = useVektorSocket();
  const upsertEntity = useEntityStore((s) => s.upsertEntity);
  const removeEntity = useEntityStore((s) => s.removeEntity);

  useEffect(() => {
    if (!socket) return;

    const unsubscribers = [
      onValidated(socket, "entity:new", (entity) => upsertEntity(entity), onInvalid),
      onValidated(socket, "entity:updated", (event) => upsertEntity(event.entity), onInvalid),
      onValidated(socket, "entity:lost", (event) => removeEntity(event.entity_id), onInvalid),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [socket, upsertEntity, removeEntity, onInvalid]);
}
