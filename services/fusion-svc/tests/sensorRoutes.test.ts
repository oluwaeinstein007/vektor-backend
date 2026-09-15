// RBAC coverage for the /api/v1/sensors routes added alongside the sensor
// registry (see sensorRegistry.test.ts for the query-layer behavior this
// builds on) — 07-data-api.md §13.1: GET is "All roles", POST/DELETE are
// SuperAdmin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import { buildApp } from "../src/app.js";
import { deleteSensorRegistration } from "../src/sensors/queries.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("GET /api/v1/sensors is reachable by any authenticated role", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/sensors",
    headers: await testAuth.authHeader({ sub: "viewer-1", roles: ["Viewer"] }),
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
});

test("GET /api/v1/sensors rejects a missing token with 401", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({ method: "GET", url: "/api/v1/sensors" });
  assert.equal(res.statusCode, 401);
});

test("POST /api/v1/sensors rejects a non-SuperAdmin role with 403, accepts SuperAdmin", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  const sensorId = `rbac-test-${Date.now()}`;
  t.after(async () => {
    await deleteSensorRegistration(db, sensorId);
    await app.close();
    await db.$client.end();
  });

  const body = {
    sensor_id: sensorId,
    sensor_type: "AIS",
    label: "RBAC test sensor",
    position: { lat: 1, lon: 1 },
    coverage_radius_m: 1000,
  };

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/v1/sensors",
    headers: await testAuth.authHeader({ sub: "cdr-1", roles: ["Commander"] }),
    payload: body,
  });
  assert.equal(forbidden.statusCode, 403);

  const allowed = await app.inject({
    method: "POST",
    url: "/api/v1/sensors",
    headers: await testAuth.authHeader({ sub: "admin-1", roles: ["SuperAdmin"] }),
    payload: body,
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.json().sensor_id, sensorId);
});

test("DELETE /api/v1/sensors/:id rejects a non-SuperAdmin role with 403", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({
    method: "DELETE",
    url: "/api/v1/sensors/whatever",
    headers: await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] }),
  });
  assert.equal(res.statusCode, 403);
});
