import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import { buildApp } from "../src/app.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("POST /api/v1/audit writes an entry, GET /api/v1/audit retrieves it", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const marker = `TEST-APP-${Date.now()}`;

  const writeRes = await app.inject({
    method: "POST",
    url: "/api/v1/audit",
    payload: {
      actor_user_id: marker,
      actor_role: "SuperAdmin",
      action: "model.upload",
      resource_type: "model",
      resource_id: "yolov8n-v3",
      metadata: { size_mb: 12 },
    },
  });
  assert.equal(writeRes.statusCode, 200);
  const written = writeRes.json();
  assert.equal(written.actor_user_id, marker);
  assert.equal(written.action, "model.upload");

  const readRes = await app.inject({
    method: "GET",
    url: `/api/v1/audit?actor_user_id=${marker}`,
    headers: await testAuth.authHeader({ sub: "admin-1", roles: ["SuperAdmin"] }),
  });
  assert.equal(readRes.statusCode, 200);
  const rows = readRes.json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_id, "yolov8n-v3");
});

test("GET / lists this service's endpoints", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().service, "audit-svc");
});
