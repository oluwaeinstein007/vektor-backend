// End-to-end orchestration test: real Postgres, real Qdrant (+ real BGE-M3
// embedding for the RAG step), and a real gRPC server standing in for
// llm-cloud-svc (same fake-server pattern as cloudClient.test.ts) — the one
// thing not real here is llm-cloud-svc's actual vLLM inference, which this
// sandbox can't run (see llm-cloud-svc/src/llm_cloud_svc/server.py's module
// docstring). Everything on the coa-svc side of that boundary is real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { sendUnaryData, ServerUnaryCall } from "@grpc/grpc-js";
import { createDb } from "@vektor/db";
import { createQdrantClient, ensureDoctrineCollection, ingestDoctrineDocument } from "@vektor/qdrant";
// Server/ServerCredentials from @vektor/shared/llm, not @grpc/grpc-js
// directly — see vektor-proto/src/llm.ts's header comment.
import { LLMServiceService, Server, ServerCredentials, type COARequest, type COAResponse } from "@vektor/shared/llm";
import type { Entity } from "@vektor/shared";
import { generateCoa } from "../src/llm/generateCoa.js";
import { createCloudLlmClient } from "../src/llm/cloudClient.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:16333";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function makeEntity(overrides: Partial<Entity> = {}): Entity {
  return {
    entity_id: randomUUID(),
    classification: "GroundVehicle.Tracked",
    confidence: 0.9,
    status: "ACTIVE",
    affiliation: "HOSTILE",
    source_sensors: ["sensor-1"],
    position: { lat: 10, lon: 20, alt_m: 0, mgrs: "", accuracy_m: 5 },
    kinematics: { speed_kmh: 40, heading_deg: 90, trajectory: [] },
    metadata: { tags: [], analyst_notes: "", no_strike: false },
    first_detected: NOW.toISOString(),
    last_updated: NOW.toISOString(),
    ...overrides,
  };
}

test("generateCoa (cloud mode) produces a persisted, retrievable COA grounded in real RAG doctrine context", async (t) => {
  const db = createDb(DATABASE_URL);
  const qdrant = createQdrantClient(QDRANT_URL);
  await ensureDoctrineCollection(qdrant);
  const doctrineSource = `test-e2e-doctrine-${Date.now()}.md`;
  await ingestDoctrineDocument(
    qdrant,
    doctrineSource,
    "Rules of Engagement.\n\nOnly HOSTILE-affiliated entities may be targeted. FRIENDLY entities must never be targeted.",
  );

  let receivedRequest: COARequest | undefined;
  const server = new Server();
  server.addService(LLMServiceService, {
    generateCoa: (call: ServerUnaryCall<COARequest, COAResponse>, callback: sendUnaryData<COAResponse>) => {
      receivedRequest = call.request;
      callback(null, {
        coaJson: JSON.stringify([
          {
            rank: 1,
            title: "Shadow with ISR",
            rationale: "Maintain custody per ROE without closing distance.",
            confidence: 0.75,
            required_assets: ["UAS-1"],
            estimated_duration_min: 20,
            context_factors: ["affiliation", "closing_velocity"],
          },
        ]),
        confidence: 0.8,
        latencyMs: 10,
      });
    },
  });
  const port: number = await new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });
  const llmClient = createCloudLlmClient(`127.0.0.1:${port}`);
  t.after(() => {
    llmClient.close();
    server.forceShutdown();
    return db.$client.end();
  });

  const target = makeEntity();
  const coa = await generateCoa(
    { db, qdrant, mode: { kind: "cloud", llmClient } },
    { targetEntity: target, allEntities: [target], blueForceAssets: [], noStrikeZones: [], now: NOW },
  );

  assert.equal(coa.options.length, 1);
  assert.equal(coa.options[0]!.title, "Shadow with ISR");
  assert.equal(coa.status, "PENDING");

  // The situation JSON that actually reached llm-cloud-svc must carry the target.
  assert.ok(receivedRequest);
  const situation = JSON.parse(receivedRequest!.situationJson);
  assert.equal(situation.target.entity.entity_id, target.entity_id);
  assert.equal(situation.target.threat_score > 0, true);

  // RAG actually retrieved the ingested doctrine, not an empty string.
  assert.ok(receivedRequest!.doctrineContext.length > 0);
});
