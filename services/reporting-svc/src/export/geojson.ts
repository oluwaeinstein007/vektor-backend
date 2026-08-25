import type { ExportRow } from "./query.js";

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] } | null;
    properties: Record<string, unknown>;
  }>;
}

export function toGeoJson(rows: ExportRow[]): GeoJsonFeatureCollection {
  return {
    type: "FeatureCollection",
    features: rows.map((r) => ({
      type: "Feature",
      geometry: r.lon !== null && r.lat !== null ? { type: "Point", coordinates: [r.lon, r.lat] } : null,
      properties: {
        entity_id: r.entity_id,
        classification: r.classification,
        affiliation: r.affiliation,
        status: r.status,
        alt_m: r.alt_m,
        last_updated: r.last_updated.toISOString(),
      },
    })),
  };
}
