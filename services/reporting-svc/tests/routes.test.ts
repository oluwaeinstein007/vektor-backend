// REST surface tests via app.inject() — real Postgres + real headless
// Chrome/pptxgenjs generation (same as generate.integration.test.ts, just
// driven through HTTP instead of calling generateReport directly).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import { buildApp } from "../src/app.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("POST /api/v1/reports then GET /api/v1/reports/:id returns a real generated PDF", async (t) => {
  const db = createDb(DATABASE_URL);
  const dir = await mkdtemp(join(tmpdir(), "vektor-reports-"));
  const testAuth = await createTestAuth();
  const app = buildApp({ db, storageDir: dir, auth: testAuth.authOptions, logger: false });
  t.after(() => app.close());
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => db.$client.end());

  const analystHeader = await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] });
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/reports",
    payload: { format: "PDF" },
    headers: analystHeader,
  });
  assert.equal(createRes.statusCode, 200);
  const created = createRes.json() as { report_id: string; status: string };
  assert.equal(created.status, "COMPLETE");

  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/reports/${created.report_id}`,
    headers: analystHeader,
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.headers["content-type"], "application/pdf");
  const buffer = getRes.rawPayload;
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");

  const notFound = await app.inject({
    method: "GET",
    url: `/api/v1/reports/${randomUUID()}`,
    headers: analystHeader,
  });
  assert.equal(notFound.statusCode, 404);
});

test("GET /api/v1/export returns real CSV and GeoJSON for entities in range", async (t) => {
  const db = createDb(DATABASE_URL);
  const dir = await mkdtemp(join(tmpdir(), "vektor-reports-"));
  const testAuth = await createTestAuth();
  const app = buildApp({ db, storageDir: dir, auth: testAuth.authOptions, logger: false });
  t.after(() => app.close());
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => db.$client.end());

  const analystHeader = await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] });
  const entityId = randomUUID();
  const now = new Date();
  await db.execute(sql`
    INSERT INTO entities (entity_id, classification, confidence, status, affiliation, source_sensors, position, alt_m, accuracy_m, kinematics, metadata, first_detected, last_updated)
    VALUES (${entityId}, 'Test.Widget', 0.9, 'ACTIVE', 'NEUTRAL', ARRAY['test'], ST_SetSRID(ST_MakePoint(10, 50), 0), 0, 5, '{}'::jsonb, '{}'::jsonb, ${now.toISOString()}, ${now.toISOString()})
  `);

  try {
    const from = new Date(now.getTime() - 60_000).toISOString();
    const to = new Date(now.getTime() + 60_000).toISOString();

    const csvRes = await app.inject({
      method: "GET",
      url: `/api/v1/export?format=csv&from=${from}&to=${to}`,
      headers: analystHeader,
    });
    assert.equal(csvRes.statusCode, 200);
    assert.equal(csvRes.headers["content-type"], "text/csv");
    assert.ok(csvRes.body.includes(entityId));

    const geojsonRes = await app.inject({
      method: "GET",
      url: `/api/v1/export?format=geojson&from=${from}&to=${to}`,
      headers: analystHeader,
    });
    assert.equal(geojsonRes.statusCode, 200);
    const body = geojsonRes.json() as { type: string; features: Array<{ properties: { entity_id: string } }> };
    assert.equal(body.type, "FeatureCollection");
    assert.ok(body.features.some((f) => f.properties.entity_id === entityId));
  } finally {
    await db.execute(sql`DELETE FROM entities WHERE entity_id = ${entityId}`);
  }
});
