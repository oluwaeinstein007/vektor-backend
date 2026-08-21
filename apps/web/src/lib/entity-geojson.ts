import type { Entity } from "@vektor/shared";

export const AFFILIATION_COLORS: Record<Entity["affiliation"], string> = {
  FRIENDLY: "#3b82f6",
  HOSTILE: "#ef4444",
  NEUTRAL: "#eab308",
  UNKNOWN: "#9ca3af",
};

export function toFeatureCollection(entities: Map<string, Entity>): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: Array.from(entities.values()).map((entity) => ({
      type: "Feature",
      id: entity.entity_id,
      geometry: { type: "Point", coordinates: [entity.position.lon, entity.position.lat] },
      properties: {
        entity_id: entity.entity_id,
        classification: entity.classification,
        affiliation: entity.affiliation,
        confidence: entity.confidence,
        color: AFFILIATION_COLORS[entity.affiliation],
      },
    })),
  };
}
