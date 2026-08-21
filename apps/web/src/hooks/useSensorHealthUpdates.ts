"use client";

import { useEffect } from "react";
import { useVektorSocket } from "@/lib/socket-provider";
import { onValidated } from "@/lib/socket-client";
import { useSensorHealthStore } from "@/stores/sensor-health-store";

/** FE-003: keeps useSensorHealthStore in sync with sensor:status. */
export function useSensorHealthUpdates(onInvalid?: (event: string, error: unknown) => void) {
  const socket = useVektorSocket();
  const upsertSensor = useSensorHealthStore((s) => s.upsertSensor);

  useEffect(() => {
    if (!socket) return;
    const unsubscribe = onValidated(socket, "sensor:status", (health) => upsertSensor(health), onInvalid);
    return unsubscribe;
  }, [socket, upsertSensor, onInvalid]);
}
