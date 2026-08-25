import type { Entity } from "@vektor/shared";
import { AFFILIATION_COLORS, AFFILIATION_FRAME, classifyEntity } from "./entity-symbols";

export { AFFILIATION_COLORS };

export function toFeatureCollection(entities: Map<string, Entity>): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: Array.from(entities.values()).map((entity) => {
      const { glyph, label } = classifyEntity(entity.classification);
      return {
        type: "Feature",
        id: entity.entity_id,
        geometry: { type: "Point", coordinates: [entity.position.lon, entity.position.lat] },
        properties: {
          entity_id: entity.entity_id,
          classification: entity.classification,
          affiliation: entity.affiliation,
          confidence: entity.confidence,
          color: AFFILIATION_COLORS[entity.affiliation],
          frame: `frame-${AFFILIATION_FRAME[entity.affiliation]}`,
          glyph: `glyph-${glyph}`,
          // aircraft/vessel glyphs are drawn nose/bow-up (north) by default
          // and rotated per-feature to the EKF-smoothed heading; emitter/
          // unknown glyphs are radially symmetric so a stray heading value
          // there doesn't matter.
          rotation: glyph === "aircraft" || glyph === "vessel" ? entity.kinematics.heading_deg : 0,
          label: `${label} · ${entity.affiliation}`,
        },
      };
    }),
  };
}
