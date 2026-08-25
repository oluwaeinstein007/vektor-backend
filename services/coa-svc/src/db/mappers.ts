// Storage-row -> wire mappers — same discipline as every other service in
// this codebase (geospatial-svc's entity mapper, fusion-svc's blue-force
// mappers): a DB row is never cast `as X`, it's always run through
// X.parse() so a schema drift fails loudly instead of shipping silently
// (REQ-9.1). coa-svc reads `entities`/`blue_force_assets` directly via
// Drizzle (the same shared-Postgres-instance pattern geospatial-svc and
// fusion-svc already use for these tables — see this repo's established
// "every consuming service owns its own row->wire mapper" convention), so
// it needs its own copies of these two mappers, not just the COA one.
import mgrsPkg from "mgrs";
import { COA, Entity, BlueForceAsset } from "@vektor/shared";
import type { coas, entities, blueForceAssets } from "@vektor/db";

const { forward: toMgrs } = mgrsPkg;

type CoaRow = typeof coas.$inferSelect;
type EntityRow = typeof entities.$inferSelect;
type BlueForceAssetRow = typeof blueForceAssets.$inferSelect;

const DEFAULT_KINEMATICS = { speed_kmh: 0, heading_deg: 0, trajectory: [] };
const DEFAULT_METADATA = { tags: [], analyst_notes: "", no_strike: false };

export function toWireCoa(row: CoaRow): COA {
  return COA.parse({
    coa_id: row.coa_id,
    situation_id: row.situation_id,
    generated_at: new Date(row.generated_at ?? Date.now()).toISOString(),
    options: row.options,
    selected_option: row.selected_option,
    commander_notes: row.commander_notes,
    status: row.status,
  });
}

export function toWireEntity(row: EntityRow): Entity {
  const [lon, lat] = (row.position as [number, number] | null) ?? [0, 0];
  return Entity.parse({
    entity_id: row.entity_id,
    classification: row.classification,
    confidence: row.confidence,
    status: row.status,
    affiliation: row.affiliation,
    source_sensors: row.source_sensors,
    position: { lat, lon, alt_m: row.alt_m, mgrs: toMgrs([lon, lat]), accuracy_m: row.accuracy_m },
    kinematics: { ...DEFAULT_KINEMATICS, ...(row.kinematics as Partial<typeof DEFAULT_KINEMATICS> | null) },
    metadata: { ...DEFAULT_METADATA, ...(row.metadata as Partial<typeof DEFAULT_METADATA> | null) },
    first_detected: row.first_detected?.toISOString(),
    last_updated: row.last_updated?.toISOString(),
  });
}

export function toWireBlueForceAsset(row: BlueForceAssetRow): BlueForceAsset {
  const [lon, lat] = (row.position as [number, number] | null) ?? [0, 0];
  return BlueForceAsset.parse({
    asset_id: row.asset_id,
    callsign: row.callsign,
    classification: row.classification,
    position: { lat, lon, alt_m: row.alt_m },
    buffer_radius_m: row.buffer_radius_m,
    last_updated: (row.last_updated ?? new Date()).toISOString(),
  });
}
