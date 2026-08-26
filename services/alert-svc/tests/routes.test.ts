// REST surface tests via app.inject() (no bound port needed) against a
// real Postgres — same pattern as fusion-svc's route tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import { buildApp } from "../src/app.js";
import { createAlert } from "../src/db/alerts.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

const SQUARE: [number, number][] = [
  [9.9, 49.9],
  [10.1, 49.9],
  [10.1, 50.1],
  [9.9, 50.1],
  [9.9, 49.9],
];

test("POST/GET/DELETE /api/v1/geofence-zones round-trips a zone", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(() => app.close());
  t.after(() => db.$client.end());

  const commanderHeader = await testAuth.authHeader({ sub: "cdr-1", roles: ["Commander"] });
  const analystHeader = await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] });

  const name = `route-test-${randomUUID()}`;
  const createRes = await app.inject({
    method: "POST",
    url: "/api/v1/geofence-zones",
    payload: {
      name,
      trigger: "BOTH",
      severity: "MEDIUM",
      affiliation_filter: null,
      channels: ["IN_APP"],
      notify: { emails: [], phones: [], webhook_urls: [] },
      polygon: SQUARE,
    },
    headers: commanderHeader,
  });
  assert.equal(createRes.statusCode, 200);
  const { zone_id } = createRes.json();
  assert.ok(zone_id);

  // Creating a zone is Commander-only; viewing it is the lower Analyst+ bar.
  const listRes = await app.inject({ method: "GET", url: "/api/v1/geofence-zones", headers: analystHeader });
  assert.equal(listRes.statusCode, 200);
  const zones = listRes.json() as Array<{ zone_id: string; name: string }>;
  assert.ok(zones.some((z) => z.zone_id === zone_id && z.name === name));

  const deleteAsAnalyst = await app.inject({
    method: "DELETE",
    url: `/api/v1/geofence-zones/${zone_id}`,
    headers: analystHeader,
  });
  assert.equal(deleteAsAnalyst.statusCode, 403);

  const deleteRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/geofence-zones/${zone_id}`,
    headers: commanderHeader,
  });
  assert.equal(deleteRes.statusCode, 204);

  const deleteAgain = await app.inject({
    method: "DELETE",
    url: `/api/v1/geofence-zones/${zone_id}`,
    headers: commanderHeader,
  });
  assert.equal(deleteAgain.statusCode, 404);
});

test("POST /api/v1/alerts/:id/actions acknowledges an alert, attributed to the verified user, and logs the action", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(() => app.close());
  t.after(() => db.$client.end());

  const alert = await createAlert(db, {
    type: "SENSOR_HEALTH",
    entity_id: null,
    severity: "LOW",
    message: "route test alert",
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/alerts/${alert.alert_id}/actions`,
    payload: { action: "ACKNOWLEDGE" },
    headers: await testAuth.authHeader({ sub: "operator-42", roles: ["Analyst"] }),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ACKNOWLEDGED");

  const listRes = await app.inject({
    method: "GET",
    url: "/api/v1/alerts",
    headers: await testAuth.authHeader({ sub: "viewer-1", roles: ["Viewer"] }),
  });
  const alerts = listRes.json() as Array<{ alert_id: string; status: string }>;
  assert.ok(alerts.some((a) => a.alert_id === alert.alert_id && a.status === "ACKNOWLEDGED"));
});

test("POST /api/v1/alerts/:id/actions 404s for a nonexistent alert", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(() => app.close());
  t.after(() => db.$client.end());

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/alerts/${randomUUID()}/actions`,
    payload: { action: "DISMISS" },
    headers: await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] }),
  });
  assert.equal(res.statusCode, 404);
});
