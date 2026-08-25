// SVC-012 — REQ-4.1: "Rank active entities in Target Workbench by
// threat/priority score ... algorithm documented and auditable." This is a
// fixed, documented weighted sum, not a model — every factor's raw value,
// weight, and contribution is returned alongside the total (`ThreatFactor[]`
// in @vektor/proto), so "auditable" means a commander can actually see why
// an entity ranked where it did, not just trust a black-box number.
//
// The five factors and their weights (sum to 1.0) come from
// doctrine/threat-classification-guide.md's four sections plus REQ-3.3's
// blue-force deconfliction concern:
//   - affiliation (0.35)            - only HOSTILE should ever dominate the queue
//   - classification_confidence (0.15) - raw sensor/CV confidence
//   - sensor_corroboration (0.15)   - multi-sensor tracks are more trustworthy
//   - proximity_to_blue_force (0.20) - closer to a protected asset = higher priority
//   - staleness (0.15)              - an old position estimate is less trustworthy
import type { Entity, BlueForceAsset, RankedEntity, ThreatFactor } from "@vektor/shared";
import { haversineMeters } from "./geo.js";

export interface ScoringContext {
  now: Date;
  blueForceAssets: BlueForceAsset[];
}

const AFFILIATION_VALUE: Record<Entity["affiliation"], number> = {
  HOSTILE: 1.0,
  UNKNOWN: 0.5,
  NEUTRAL: 0.2,
  FRIENDLY: 0.0,
};

// Linear falloff between a "fully triggers" and "no longer relevant"
// distance — clamped to [0,1], not a hard cutoff, so a target crossing the
// threshold doesn't cause a priority cliff.
function linearFalloff(value: number, fullAt: number, zeroAt: number): number {
  if (value <= fullAt) return 1;
  if (value >= zeroAt) return 0;
  return 1 - (value - fullAt) / (zeroAt - fullAt);
}

function proximityToBlueForce(entity: Entity, blueForceAssets: BlueForceAsset[]): number {
  if (blueForceAssets.length === 0) return 0; // no protected assets registered — no proximity signal to score
  const distances = blueForceAssets.map((asset) => haversineMeters(entity.position, asset.position));
  const nearest = Math.min(...distances);
  return linearFalloff(nearest, 1_000, 50_000); // full weight within 1km, none beyond 50km
}

function staleness(entity: Entity, now: Date): number {
  const ageSeconds = (now.getTime() - new Date(entity.last_updated).getTime()) / 1000;
  return linearFalloff(Math.max(0, ageSeconds), 30, 600); // full weight under 30s old, none beyond 10min
}

export function scoreEntity(entity: Entity, ctx: ScoringContext): RankedEntity {
  const rawFactors: Array<{ name: string; weight: number; value: number }> = [
    { name: "affiliation", weight: 0.35, value: AFFILIATION_VALUE[entity.affiliation] },
    { name: "classification_confidence", weight: 0.15, value: entity.confidence },
    { name: "sensor_corroboration", weight: 0.15, value: Math.min(entity.source_sensors.length / 3, 1) },
    { name: "proximity_to_blue_force", weight: 0.2, value: proximityToBlueForce(entity, ctx.blueForceAssets) },
    { name: "staleness", weight: 0.15, value: staleness(entity, ctx.now) },
  ];

  const factors: ThreatFactor[] = rawFactors.map((f) => ({ ...f, contribution: f.weight * f.value }));
  const threat_score = Math.max(0, Math.min(1, factors.reduce((sum, f) => sum + f.contribution, 0)));

  return { entity, threat_score, factors };
}

export function rankEntities(entities: Entity[], ctx: ScoringContext): RankedEntity[] {
  return entities.map((e) => scoreEntity(e, ctx)).sort((a, b) => b.threat_score - a.threat_score);
}
