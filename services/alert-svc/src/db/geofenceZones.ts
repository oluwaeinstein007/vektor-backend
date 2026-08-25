// SVC-014 — REQ-5.1. geofence_zones.geom is a polygon, so every touch goes
// through raw `sql` (Drizzle's geometry() helper is point-only — see
// packages/db/src/schema/blueForce.ts's header comment, same pattern
// fusion-svc's blueforce/queries.ts already established for no_strike_zones).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { VektorDb } from "@vektor/db";
import type { GeofenceTrigger, AlertSeverity, EntityAffiliation, AlertChannel, NotifyConfig } from "@vektor/shared";

export interface CreateZoneInput {
  name: string;
  trigger: GeofenceTrigger;
  severity: AlertSeverity;
  affiliation_filter: EntityAffiliation | null;
  channels: AlertChannel[];
  notify: NotifyConfig;
  polygon: [number, number][]; // [lon, lat] ring, first === last
  active?: boolean;
}

export interface GeofenceZoneRow {
  zone_id: string;
  name: string;
  trigger: string;
  severity: string;
  affiliation_filter: string | null;
  channels: AlertChannel[];
  notify: NotifyConfig;
  active: boolean;
  created_at: Date;
}

function polygonToWkt(ring: [number, number][]): string {
  const points = ring.map(([lon, lat]) => `${lon} ${lat}`).join(", ");
  return `POLYGON((${points}))`;
}

export async function createZone(db: VektorDb, input: CreateZoneInput): Promise<string> {
  const zoneId = randomUUID();
  const wkt = polygonToWkt(input.polygon);
  await db.execute(sql`
    INSERT INTO geofence_zones (zone_id, name, trigger, severity, affiliation_filter, channels, notify, geom, active, created_at)
    VALUES (
      ${zoneId}, ${input.name}, ${input.trigger}, ${input.severity}, ${input.affiliation_filter},
      ${JSON.stringify(input.channels)}::jsonb, ${JSON.stringify(input.notify)}::jsonb,
      ST_SetSRID(ST_GeomFromText(${wkt}), 4326), ${input.active ?? true}, now()
    )
  `);
  return zoneId;
}

export async function deleteZone(db: VektorDb, zoneId: string): Promise<boolean> {
  const result = await db.execute(sql`DELETE FROM geofence_zones WHERE zone_id = ${zoneId} RETURNING zone_id`);
  return result.length > 0;
}

export async function listZones(db: VektorDb): Promise<GeofenceZoneRow[]> {
  const rows = await db.execute<{
    zone_id: string;
    name: string;
    trigger: string;
    severity: string;
    affiliation_filter: string | null;
    channels: AlertChannel[];
    notify: NotifyConfig;
    active: boolean;
    created_at: Date;
  }>(sql`
    SELECT zone_id, name, trigger, severity, affiliation_filter, channels, notify, active, created_at
    FROM geofence_zones
  `);
  return rows as unknown as GeofenceZoneRow[];
}

/**
 * REQ-5.1 core check: which active zones (optionally trigger-filtered)
 * currently contain this position? Callers diff this against the
 * previously-known containing set to detect entry/exit — see
 * queue/worker.ts's checkGeofences. Same SRID-0-vs-4326 fix as
 * fusion-svc's isInNoStrikeZone (entities.position carries no SRID label).
 */
export async function zonesContaining(
  db: VektorDb,
  position: { lat: number; lon: number },
  affiliation: EntityAffiliation,
): Promise<GeofenceZoneRow[]> {
  const rows = await db.execute<{
    zone_id: string;
    name: string;
    trigger: string;
    severity: string;
    affiliation_filter: string | null;
    channels: AlertChannel[];
    notify: NotifyConfig;
    active: boolean;
    created_at: Date;
  }>(sql`
    SELECT zone_id, name, trigger, severity, affiliation_filter, channels, notify, active, created_at
    FROM geofence_zones
    WHERE active = true
      AND (affiliation_filter IS NULL OR affiliation_filter = ${affiliation})
      AND ST_Contains(geom, ST_SetSRID(ST_MakePoint(${position.lon}, ${position.lat}), 4326))
  `);
  return rows as unknown as GeofenceZoneRow[];
}
