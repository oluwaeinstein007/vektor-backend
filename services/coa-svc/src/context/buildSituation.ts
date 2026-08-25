// ML-009 — assembles the "situation" object serialized as COARequest's
// situation_json. Every string field that could originate from an operator
// or sensor (never from a fixed enum/number) goes through sanitizeForPrompt
// (Pitfall 4). Structured JSON, not free text, is what reaches the model —
// see llm-cloud-svc/server.py's _build_prompt for the other half of that
// mitigation.
import type { Entity, BlueForceAsset, NoStrikeZone, RankedEntity } from "@vektor/shared";
import { sanitizeForPrompt } from "./sanitize.js";
import { haversineMeters } from "../threat/geo.js";

const NEARBY_RADIUS_M = 20_000; // 20km — matches the outer edge of scoring.ts's proximity falloff

function sanitizeEntity(entity: Entity): Entity {
  return {
    ...entity,
    metadata: {
      ...entity.metadata,
      analyst_notes: sanitizeForPrompt(entity.metadata.analyst_notes),
      tags: entity.metadata.tags.map(sanitizeForPrompt),
    },
  };
}

export interface Situation {
  situation_id: string;
  generated_at: string;
  target: RankedEntity;
  nearby_entities: Entity[];
  blue_force_assets: BlueForceAsset[];
  no_strike_zones: NoStrikeZone[];
}

export interface BuildSituationParams {
  situation_id: string;
  target: RankedEntity;
  allEntities: Entity[];
  blueForceAssets: BlueForceAsset[];
  noStrikeZones: NoStrikeZone[];
  now: Date;
}

export function buildSituation(params: BuildSituationParams): Situation {
  const nearby_entities = params.allEntities
    .filter((e) => e.entity_id !== params.target.entity.entity_id)
    .filter((e) => haversineMeters(params.target.entity.position, e.position) <= NEARBY_RADIUS_M)
    .map(sanitizeEntity);

  return {
    situation_id: params.situation_id,
    generated_at: params.now.toISOString(),
    target: { ...params.target, entity: sanitizeEntity(params.target.entity) },
    nearby_entities,
    blue_force_assets: params.blueForceAssets,
    no_strike_zones: params.noStrikeZones,
  };
}

/** The text embedded to retrieve RAG doctrine context — deliberately not the
 * raw situation JSON (an embedding of structured JSON keys/punctuation is a
 * poor semantic match against prose doctrine text); this is a short natural-
 * language description of what doctrine would actually be relevant. */
export function buildDoctrineQuery(situation: Situation): string {
  const parts = [
    `${situation.target.entity.affiliation} ${situation.target.entity.classification}`,
    `threat score ${situation.target.threat_score.toFixed(2)}`,
  ];
  if (situation.no_strike_zones.length > 0) {
    parts.push("no-strike zone deconfliction");
  }
  if (situation.blue_force_assets.length > 0) {
    parts.push("blue force asset tasking");
  }
  return parts.join(", ");
}
