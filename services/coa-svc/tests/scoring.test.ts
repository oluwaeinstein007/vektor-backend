import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreEntity, rankEntities } from "../src/threat/scoring.js";
import type { Entity, BlueForceAsset } from "@vektor/shared";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    entity_id: "00000000-0000-0000-0000-000000000001",
    classification: "GroundVehicle.Tracked",
    confidence: 0.9,
    status: "ACTIVE",
    affiliation: "HOSTILE",
    source_sensors: ["sensor-1", "sensor-2", "sensor-3"],
    position: { lat: 10, lon: 20, alt_m: 0, mgrs: "", accuracy_m: 5 },
    kinematics: { speed_kmh: 0, heading_deg: 0, trajectory: [] },
    metadata: { tags: [], analyst_notes: "", no_strike: false },
    first_detected: NOW.toISOString(),
    last_updated: NOW.toISOString(),
    ...overrides,
  };
}

test("threat_score is the sum of each factor's weight*value, matching the returned factors exactly", () => {
  const entity = makeEntity();
  const ranked = scoreEntity(entity, { now: NOW, blueForceAssets: [] });

  const expected = ranked.factors.reduce((sum, f) => sum + f.contribution, 0);
  assert.ok(Math.abs(ranked.threat_score - expected) < 1e-9);
  for (const f of ranked.factors) {
    assert.ok(Math.abs(f.contribution - f.weight * f.value) < 1e-9);
  }
});

test("HOSTILE outscores FRIENDLY when every other factor is identical", () => {
  const hostile = scoreEntity(makeEntity({ affiliation: "HOSTILE" }), { now: NOW, blueForceAssets: [] });
  const friendly = scoreEntity(makeEntity({ affiliation: "FRIENDLY" }), { now: NOW, blueForceAssets: [] });
  assert.ok(hostile.threat_score > friendly.threat_score);
});

test("a track corroborated by 3 sensors outscores an identical single-sensor track", () => {
  const multi = scoreEntity(makeEntity({ source_sensors: ["a", "b", "c"] }), { now: NOW, blueForceAssets: [] });
  const single = scoreEntity(makeEntity({ source_sensors: ["a"] }), { now: NOW, blueForceAssets: [] });
  assert.ok(multi.threat_score > single.threat_score);
});

test("proximity to a blue-force asset increases score; far away contributes ~0", () => {
  const asset: BlueForceAsset = {
    asset_id: "10000000-0000-0000-0000-000000000001",
    callsign: "OUTPOST-1",
    classification: "Base",
    position: { lat: 10, lon: 20, alt_m: 0 },
    buffer_radius_m: 500,
    last_updated: NOW.toISOString(),
  };
  const close = scoreEntity(makeEntity({ position: { lat: 10.001, lon: 20, alt_m: 0, mgrs: "", accuracy_m: 5 } }), {
    now: NOW,
    blueForceAssets: [asset],
  });
  const far = scoreEntity(makeEntity({ position: { lat: 50, lon: 20, alt_m: 0, mgrs: "", accuracy_m: 5 } }), {
    now: NOW,
    blueForceAssets: [asset],
  });
  assert.ok(close.threat_score > far.threat_score);

  const proximityFactor = far.factors.find((f) => f.name === "proximity_to_blue_force")!;
  assert.equal(proximityFactor.value, 0);
});

test("a stale track (last_updated long ago) scores lower than an identical fresh track", () => {
  const fresh = scoreEntity(makeEntity({ last_updated: NOW.toISOString() }), { now: NOW, blueForceAssets: [] });
  const staleTime = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString(); // 20 min old
  const stale = scoreEntity(makeEntity({ last_updated: staleTime }), { now: NOW, blueForceAssets: [] });
  assert.ok(fresh.threat_score > stale.threat_score);
});

test("threat_score is always within [0,1]", () => {
  const best = scoreEntity(
    makeEntity({ affiliation: "HOSTILE", confidence: 1, source_sensors: ["a", "b", "c", "d"] }),
    {
      now: NOW,
      blueForceAssets: [
        {
          asset_id: "10000000-0000-0000-0000-000000000001",
          callsign: "OUTPOST-1",
          classification: "Base",
          position: { lat: 10, lon: 20, alt_m: 0 },
          buffer_radius_m: 500,
          last_updated: NOW.toISOString(),
        },
      ],
    },
  );
  assert.ok(best.threat_score <= 1 && best.threat_score >= 0);

  const worst = scoreEntity(makeEntity({ affiliation: "FRIENDLY", confidence: 0, source_sensors: [] }), {
    now: NOW,
    blueForceAssets: [],
  });
  assert.ok(worst.threat_score >= 0 && worst.threat_score <= 1);
});

test("rankEntities sorts descending by threat_score", () => {
  const low = makeEntity({ entity_id: "00000000-0000-0000-0000-000000000002", affiliation: "FRIENDLY" });
  const high = makeEntity({ entity_id: "00000000-0000-0000-0000-000000000003", affiliation: "HOSTILE" });
  const ranked = rankEntities([low, high], { now: NOW, blueForceAssets: [] });
  assert.equal(ranked[0]!.entity.entity_id, high.entity_id);
  assert.equal(ranked[1]!.entity.entity_id, low.entity_id);
});
