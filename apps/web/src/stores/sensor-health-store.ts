import { create } from "zustand";
import type { SensorHealth } from "@vektor/shared";

export interface SensorHealthState {
  sensors: Map<string, SensorHealth>;
  upsertSensor: (health: SensorHealth) => void;
}

export const useSensorHealthStore = create<SensorHealthState>((set) => ({
  sensors: new Map(),
  upsertSensor: (health) =>
    set((state) => {
      const next = new Map(state.sensors);
      next.set(health.sensor_id, health);
      return { sensors: next };
    }),
}));
