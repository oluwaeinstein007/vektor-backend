import { test } from "node:test";
import assert from "node:assert/strict";
import { toFeatureCollection } from "../src/lib/entity-geojson.ts";
import type { Entity } from "@vektor/shared";

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    entity_id: "11111111-1111-4111-8111-111111111111",
    classification: "GroundVehicle.Tracked",
    confidence: 0.9,
    status: "ACTIVE",
    affiliation: "HOSTILE",
    source_sensors: ["sensor-1"],
    position: { lat: 51.9225, lon: 4.352, alt_m: 0, mgrs: "31UFT1234567890", accuracy_m: 5 },
    kinematics: { speed_kmh: 10, heading_deg: 90, trajectory: [] },
    metadata: { tags: [], analyst_notes: "", no_strike: false },
    first_detected: "2026-08-21T00:00:00.000Z",
    last_updated: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

test("converts entities to a GeoJSON FeatureCollection with [lon, lat] point coordinates", () => {
  const entity = makeEntity();
  const fc = toFeatureCollection(new Map([[entity.entity_id, entity]]));

  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 1);
  const feature = fc.features[0]!;
  assert.equal(feature.geometry.type, "Point");
  assert.deepEqual(feature.geometry.coordinates, [4.352, 51.9225]);
  assert.equal(feature.properties?.entity_id, entity.entity_id);
  assert.equal(feature.properties?.affiliation, "HOSTILE");
  assert.equal(feature.properties?.color, "#ef4444");
});

test("maps each affiliation to a distinct color", () => {
  const affiliations: Entity["affiliation"][] = ["FRIENDLY", "HOSTILE", "NEUTRAL", "UNKNOWN"];
  const entities = new Map(
    affiliations.map((affiliation, i) => {
      const entity = makeEntity({ entity_id: `${i}0000000-0000-4000-8000-000000000000`, affiliation });
      return [entity.entity_id, entity] as const;
    }),
  );

  const fc = toFeatureCollection(entities);
  const colors = new Set(fc.features.map((f) => f.properties?.color));
  assert.equal(colors.size, 4, "each affiliation should render as a visually distinct color");
});

test("produces an empty FeatureCollection for no entities", () => {
  const fc = toFeatureCollection(new Map());
  assert.deepEqual(fc, { type: "FeatureCollection", features: [] });
});
