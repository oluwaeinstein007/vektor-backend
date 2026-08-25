// SVC-014 — REQ-5.1 entry/exit detection. Which zones an entity was
// *previously* inside has to be remembered across jobs to tell an ENTRY
// apart from "still inside, nothing changed" — stored as a Redis set per
// entity (survives an alert-svc restart, unlike the anomaly detector's
// in-memory EWMA state) rather than recomputed from alert history, since
// that would need an extra DB round-trip and history that's easy to fall
// out of sync with the live zone set if a zone's polygon is edited.
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { VektorDb } from "@vektor/db";
import type { GeofenceZone, EntityAffiliation, Position } from "@vektor/shared";
import { zonesContaining, type GeofenceZoneRow } from "../db/geofenceZones.js";

function previousZonesKey(entityId: string): string {
  return `alert-svc:entity-zones:${entityId}`;
}

export interface GeofenceTransition {
  zone: GeofenceZoneRow;
  event: "ENTRY" | "EXIT";
}

/**
 * Diffs the entity's currently-containing zone set against its previous
 * one (from Redis) and returns only the transitions each zone's own
 * `trigger` config actually wants to fire on (a BOTH-trigger zone always
 * fires; an ENTRY-only zone stays silent on exit, and vice versa).
 */
export async function checkGeofenceTransitions(
  db: VektorDb,
  redis: Redis,
  entityId: string,
  position: Pick<Position, "lat" | "lon">,
  affiliation: EntityAffiliation,
): Promise<GeofenceTransition[]> {
  const currentZones = await zonesContaining(db, position, affiliation);
  const currentIds = new Set(currentZones.map((z) => z.zone_id));

  const previousIds = new Set(await redis.smembers(previousZonesKey(entityId)));

  const transitions: GeofenceTransition[] = [];

  for (const zone of currentZones) {
    if (!previousIds.has(zone.zone_id) && (zone.trigger === "ENTRY" || zone.trigger === "BOTH")) {
      transitions.push({ zone, event: "ENTRY" });
    }
  }

  // Exited zones aren't in currentZones anymore, so their trigger config
  // has to be looked up separately — fetch by ID rather than re-querying
  // ST_Contains (the entity is, by definition, no longer inside them).
  const exitedIds = [...previousIds].filter((id) => !currentIds.has(id));
  for (const zoneId of exitedIds) {
    const zone = await zoneById(db, zoneId);
    if (zone && (zone.trigger === "EXIT" || zone.trigger === "BOTH")) {
      transitions.push({ zone, event: "EXIT" });
    }
  }

  const pipeline = redis.multi();
  pipeline.del(previousZonesKey(entityId));
  if (currentIds.size > 0) {
    pipeline.sadd(previousZonesKey(entityId), ...currentIds);
  }
  await pipeline.exec();

  return transitions;
}

async function zoneById(db: VektorDb, zoneId: string): Promise<GeofenceZoneRow | null> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT zone_id, name, trigger, severity, affiliation_filter, channels, notify, active, created_at
    FROM geofence_zones WHERE zone_id = ${zoneId}
  `);
  return (rows[0] as unknown as GeofenceZoneRow | undefined) ?? null;
}

export function zoneToWire(row: GeofenceZoneRow): Pick<GeofenceZone, "zone_id" | "name" | "severity"> {
  return { zone_id: row.zone_id, name: row.name, severity: row.severity as GeofenceZone["severity"] };
}
