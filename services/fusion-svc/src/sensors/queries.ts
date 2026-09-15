// REQ-1.8/Epic 8: sensor registration registry — Epic 8's
// `POST /api/v1/sensors` never had an implementation until now. Same
// upsert-by-natural-key shape as blueforce/queries.ts, except the key here
// is genuinely natural (sensor_id, the same string every domain adapter
// already publishes with) rather than a generated uuid.
import { eq } from "drizzle-orm";
import { sensorRegistry, type VektorDb } from "@vektor/db";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface RegisterSensorInput {
  sensor_id: string;
  sensor_type: string;
  label: string;
  position: GeoPoint;
  coverage_radius_m: number;
}

export type SensorRegistryRow = typeof sensorRegistry.$inferSelect;

export async function listSensorRegistrations(db: VektorDb): Promise<SensorRegistryRow[]> {
  return db.select().from(sensorRegistry);
}

export async function getSensorRegistration(db: VektorDb, sensorId: string): Promise<SensorRegistryRow | null> {
  const rows = await db.select().from(sensorRegistry).where(eq(sensorRegistry.sensor_id, sensorId)).limit(1);
  return rows[0] ?? null;
}

export async function deleteSensorRegistration(db: VektorDb, sensorId: string): Promise<boolean> {
  const result = await db.delete(sensorRegistry).where(eq(sensorRegistry.sensor_id, sensorId)).returning();
  return result.length > 0;
}

export async function upsertSensorRegistration(db: VektorDb, input: RegisterSensorInput): Promise<SensorRegistryRow> {
  const existing = await getSensorRegistration(db, input.sensor_id);
  const values = {
    sensor_type: input.sensor_type,
    label: input.label,
    position: [input.position.lon, input.position.lat] as [number, number],
    coverage_radius_m: input.coverage_radius_m,
  };

  const [row] = existing
    ? await db.update(sensorRegistry).set(values).where(eq(sensorRegistry.sensor_id, input.sensor_id)).returning()
    : await db.insert(sensorRegistry).values({ sensor_id: input.sensor_id, ...values }).returning();

  return row!;
}
