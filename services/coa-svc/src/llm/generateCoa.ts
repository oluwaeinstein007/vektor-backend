// The full REQ-4.2 pipeline: score the target, build a sanitized situation,
// retrieve doctrine context (RAG), call the LLM (cloud gRPC or edge
// node-llama-cpp), and persist the result. Each step already has its own
// unit/integration tests (scoring.test.ts, sanitize.test.ts,
// cloudClient.test.ts, edgeClient's fixture-model test) — this file is the
// wiring, not new logic.
import { randomUUID } from "node:crypto";
import type { Entity, BlueForceAsset, NoStrikeZone, COA } from "@vektor/shared";
import type { VektorDb } from "@vektor/db";
import type { QdrantClient } from "@vektor/qdrant";
import type { LLMServiceClient } from "@vektor/shared/llm";
import { scoreEntity } from "../threat/scoring.js";
import { buildSituation, buildDoctrineQuery } from "../context/buildSituation.js";
import { retrieveDoctrineContext } from "../context/retrieveDoctrine.js";
import { generateCoaCloud } from "./cloudClient.js";
import { generateCoaEdge } from "./edgeClient.js";
import { insertCoa } from "../db/coaQueries.js";
import { toWireCoa } from "../db/mappers.js";

export interface GenerateCoaParams {
  targetEntity: Entity;
  allEntities: Entity[];
  blueForceAssets: BlueForceAsset[];
  noStrikeZones: NoStrikeZone[];
  numOptions?: number;
  now?: Date;
}

export type CoaMode =
  | { kind: "cloud"; llmClient: LLMServiceClient }
  | { kind: "edge"; modelPath: string };

export async function generateCoa(
  deps: { db: VektorDb; qdrant: QdrantClient; mode: CoaMode },
  params: GenerateCoaParams,
): Promise<COA> {
  const now = params.now ?? new Date();
  const numOptions = params.numOptions ?? 3; // REQ-4.2: ">= 3 ranked COA options"

  const ranked = scoreEntity(params.targetEntity, { now, blueForceAssets: params.blueForceAssets });

  const situation = buildSituation({
    situation_id: randomUUID(),
    target: ranked,
    allEntities: params.allEntities,
    blueForceAssets: params.blueForceAssets,
    noStrikeZones: params.noStrikeZones,
    now,
  });

  const doctrineContext = await retrieveDoctrineContext(deps.qdrant, buildDoctrineQuery(situation));
  const situationJson = JSON.stringify(situation);

  const options =
    deps.mode.kind === "cloud"
      ? (await generateCoaCloud(deps.mode.llmClient, { situation_json: situationJson, doctrine_context: doctrineContext, num_options: numOptions })).options
      : (await generateCoaEdge({ modelPath: deps.mode.modelPath, situationJson, doctrineContext, numOptions })).options;

  const row = await insertCoa(deps.db, { situation_id: situation.situation_id, options });
  return toWireCoa(row);
}
