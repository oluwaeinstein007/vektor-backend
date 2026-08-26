import { BlueForceAsset, NoStrikeZone } from "@vektor/shared";
import type { BlueForceAssetRow, NoStrikeZoneRow } from "./queries.js";

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

export function toWireNoStrikeZone(row: NoStrikeZoneRow): NoStrikeZone {
  return NoStrikeZone.parse({
    zone_id: row.zone_id,
    name: row.name,
    source: row.source,
    source_asset_id: row.source_asset_id,
    polygon: row.polygon,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  });
}
