import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@vektor/db";
import { entities } from "@vektor/db";
import { createQdrantClient } from "@vektor/qdrant";
import { buildApp } from "../src/app.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:16333";

test("GET /api/v1/target-workbench/ranking returns ACTIVE entities sorted by threat_score descending", async (t) => {
  const db = createDb(DATABASE_URL);
  const qdrant = createQdrantClient(QDRANT_URL);
  const app = buildApp({
    db,
    qdrant,
    mode: { kind: "edge", modelPath: "/nonexistent" },
    auditSvcUrl: "http://unused",
    fusionSvcUrl: "http://unused",
    logger: false,
  });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const hostileId = randomUUID();
  const friendlyId = randomUUID();

  await db.insert(entities).values([
    {
      entity_id: hostileId,
      classification: "GroundVehicle.Tracked",
      confidence: 0.95,
      status: "ACTIVE",
      affiliation: "HOSTILE",
      source_sensors: ["s1", "s2", "s3"],
      position: [20, 10],
      alt_m: 0,
      accuracy_m: 5,
      kinematics: { speed_kmh: 0, heading_deg: 0, trajectory: [] },
      metadata: { tags: [], analyst_notes: "", no_strike: false },
    },
    {
      entity_id: friendlyId,
      classification: "GroundVehicle.Friendly",
      confidence: 0.5,
      status: "ACTIVE",
      affiliation: "FRIENDLY",
      source_sensors: ["s1"],
      position: [21, 11],
      alt_m: 0,
      accuracy_m: 5,
      kinematics: { speed_kmh: 0, heading_deg: 0, trajectory: [] },
      metadata: { tags: [], analyst_notes: "", no_strike: false },
    },
  ]);

  const res = await app.inject({ method: "GET", url: "/api/v1/target-workbench/ranking" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { entity: { entity_id: string }; threat_score: number }[];

  const hostileEntry = body.find((r) => r.entity.entity_id === hostileId);
  const friendlyEntry = body.find((r) => r.entity.entity_id === friendlyId);
  assert.ok(hostileEntry);
  assert.ok(friendlyEntry);
  assert.ok(hostileEntry!.threat_score > friendlyEntry!.threat_score);

  // Sorted descending overall (not just true for these two).
  for (let i = 1; i < body.length; i++) {
    assert.ok(body[i - 1]!.threat_score >= body[i]!.threat_score);
  }
});
