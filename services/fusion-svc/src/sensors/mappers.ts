import { SensorRegistration } from "@vektor/shared";
import type { SensorRegistryRow } from "./queries.js";

export function toWireSensorRegistration(row: SensorRegistryRow): SensorRegistration {
  const [lon, lat] = (row.position as [number, number] | null) ?? [0, 0];
  return SensorRegistration.parse({
    sensor_id: row.sensor_id,
    sensor_type: row.sensor_type,
    label: row.label,
    position: { lat, lon },
    coverage_radius_m: row.coverage_radius_m,
    registered_at: (row.registered_at ?? new Date()).toISOString(),
  });
}
