// SVC-010: blue-force registry + no-strike zone engine — REQ-3.3.
//
// blue_force_assets.position is a plain PostGIS point, so it goes through
// Drizzle's typed geometry() column exactly like entities.position does.
// no_strike_zones.geom is a polygon, which Drizzle's geometry() column
// can't represent (see packages/db/src/schema/blueForce.ts's header
// comment) — every touch of that column here is a raw `sql` fragment
// instead, same escape hatch entities.ts's bbox query already uses for
// anything PostGIS-specific.
//
// ST_Buffer needs a *geography* cast to produce a real meters-accurate
// buffer around a lat/lon point — buffering directly in degree-space would
// treat 1 degree of longitude as the same size as 1 degree of latitude,
// which is wrong everywhere except the equator.
import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { blueForceAssets, type VektorDb } from "@vektor/db";

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface UpsertBlueForceAssetInput {
  asset_id?: string; // omit to create a new asset
  callsign: string;
  classification: string;
  position: GeoPoint & { alt_m: number };
  buffer_radius_m: number;
}

export type BlueForceAssetRow = typeof blueForceAssets.$inferSelect;
export type NoStrikeZoneRow = {
  zone_id: string;
  name: string;
  source: string;
  source_asset_id: string | null;
  polygon: [number, number][];
  created_at: Date;
  updated_at: Date;
};

export async function listBlueForceAssets(db: VektorDb): Promise<BlueForceAssetRow[]> {
  return db.select().from(blueForceAssets);
}

export async function getBlueForceAsset(db: VektorDb, assetId: string): Promise<BlueForceAssetRow | null> {
  const rows = await db.select().from(blueForceAssets).where(eq(blueForceAssets.asset_id, assetId)).limit(1);
  return rows[0] ?? null;
}

export async function upsertBlueForceAsset(db: VektorDb, input: UpsertBlueForceAssetInput): Promise<BlueForceAssetRow> {
  const existing = input.asset_id ? await getBlueForceAsset(db, input.asset_id) : null;
  const values = {
    callsign: input.callsign,
    classification: input.classification,
    position: [input.position.lon, input.position.lat] as [number, number],
    alt_m: input.position.alt_m,
    buffer_radius_m: input.buffer_radius_m,
  };

  const [row] = existing
    ? await db.update(blueForceAssets).set({ ...values, last_updated: new Date() }).where(eq(blueForceAssets.asset_id, existing.asset_id)).returning()
    : await db.insert(blueForceAssets).values({ asset_id: input.asset_id ?? randomUUID(), ...values }).returning();

  await syncBlueForceBufferZone(db, row!);
  return row!;
}

export async function deleteBlueForceAsset(db: VektorDb, assetId: string): Promise<boolean> {
  // The asset's auto-buffer zone is deliberately NOT cascade-deleted — a
  // no-strike zone disappearing as a side effect of an unrelated registry
  // edit is the wrong default for this domain. It becomes an
  // analyst-owned leftover until explicitly removed via deleteNoStrikeZone.
  const result = await db.delete(blueForceAssets).where(eq(blueForceAssets.asset_id, assetId)).returning();
  return result.length > 0;
}

async function syncBlueForceBufferZone(db: VektorDb, asset: BlueForceAssetRow): Promise<void> {
  const [lon, lat] = asset.position as [number, number];
  const existing = await db.execute<{ zone_id: string }>(
    sql`SELECT zone_id FROM no_strike_zones WHERE source_asset_id = ${asset.asset_id} LIMIT 1`,
  );
  const zoneId = existing.length > 0 ? existing[0]!.zone_id : randomUUID();
  const name = `${asset.callsign} buffer`;

  await db.execute(sql`
    INSERT INTO no_strike_zones (zone_id, name, source, source_asset_id, geom, created_at, updated_at)
    VALUES (
      ${zoneId}, ${name}, 'BLUE_FORCE_BUFFER', ${asset.asset_id},
      ST_Buffer(geography(ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)), ${asset.buffer_radius_m})::geometry,
      now(), now()
    )
    ON CONFLICT (zone_id) DO UPDATE SET name = EXCLUDED.name, geom = EXCLUDED.geom, updated_at = now()
  `);
}

export interface CreateManualZoneInput {
  name: string;
  polygon: [number, number][]; // [lon, lat] ring, first === last
}

function polygonToWkt(ring: [number, number][]): string {
  const points = ring.map(([lon, lat]) => `${lon} ${lat}`).join(", ");
  return `POLYGON((${points}))`;
}

export async function createManualZone(db: VektorDb, input: CreateManualZoneInput): Promise<string> {
  const zoneId = randomUUID();
  const wkt = polygonToWkt(input.polygon);
  await db.execute(sql`
    INSERT INTO no_strike_zones (zone_id, name, source, source_asset_id, geom, created_at, updated_at)
    VALUES (${zoneId}, ${input.name}, 'MANUAL', NULL, ST_SetSRID(ST_GeomFromText(${wkt}), 4326), now(), now())
  `);
  return zoneId;
}

export async function deleteNoStrikeZone(db: VektorDb, zoneId: string): Promise<boolean> {
  const result = await db.execute(sql`DELETE FROM no_strike_zones WHERE zone_id = ${zoneId} RETURNING zone_id`);
  return result.length > 0;
}

export async function listNoStrikeZones(db: VektorDb): Promise<NoStrikeZoneRow[]> {
  const rows = await db.execute<{
    zone_id: string;
    name: string;
    source: string;
    source_asset_id: string | null;
    geom_geojson: string;
    created_at: Date;
    updated_at: Date;
  }>(sql`
    SELECT zone_id, name, source, source_asset_id, ST_AsGeoJSON(geom) AS geom_geojson, created_at, updated_at
    FROM no_strike_zones
  `);
  return rows.map(rowToWireZone);
}

function rowToWireZone(row: {
  zone_id: string;
  name: string;
  source: string;
  source_asset_id: string | null;
  geom_geojson: string;
  created_at: Date;
  updated_at: Date;
}): NoStrikeZoneRow {
  const geojson = JSON.parse(row.geom_geojson) as { coordinates: [number, number][][] };
  return {
    zone_id: row.zone_id,
    name: row.name,
    source: row.source,
    source_asset_id: row.source_asset_id,
    polygon: geojson.coordinates[0] ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** REQ-3.3: does this position fall inside any no-strike zone? entities.position carries no SRID label (see vektor-build-conventions memory) — ST_SetSRID here treats its raw numbers as WGS84 degrees, matching how they're actually populated everywhere in this codebase. */
export async function isInNoStrikeZone(db: VektorDb, position: GeoPoint): Promise<boolean> {
  const result = await db.execute<{ contained: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM no_strike_zones
      WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint(${position.lon}, ${position.lat}), 4326))
    ) AS contained
  `);
  return Boolean(result[0]?.contained);
}
