// NW-005: RBAC coverage for /api/v1/blue-force-assets and
// /api/v1/no-strike-zones — the one route surface in this repo that SEC-003
// missed. See src/blueforce/routes.ts's header comment for why reads are
// "all" and writes are "commander" when §13.1's role table has no row for
// either resource. blueForceQueries.test.ts covers the query layer these
// routes sit on; this file only asserts the gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import type { Role } from "@vektor/auth";
import { buildApp } from "../src/app.js";
import { deleteBlueForceAsset } from "../src/blueforce/queries.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("GET blue-force-assets and no-strike-zones reject an unauthenticated caller with 401", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  // The whole point of NW-005: before it, both of these returned 200 with
  // the full friendly-force picture to any caller that could reach the port.
  for (const url of ["/api/v1/blue-force-assets", "/api/v1/no-strike-zones"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `${url} should require a token`);
  }
});

test("GET blue-force-assets and no-strike-zones are readable by every authenticated role", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  // Field Operator specifically: "all" was chosen over "analyst+" because
  // UC-4.1 needs the dismounted operator to see friendly positions, and
  // "analyst+" excludes that role entirely.
  const roles: Role[] = ["Viewer", "Field Operator", "Analyst", "Logistics Officer", "Commander", "SuperAdmin"];
  for (const role of roles) {
    for (const url of ["/api/v1/blue-force-assets", "/api/v1/no-strike-zones"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: await testAuth.authHeader({ sub: `read-${role}`, roles: [role] }),
      });
      assert.equal(res.statusCode, 200, `${role} should be able to GET ${url}`);
      assert.ok(Array.isArray(res.json()));
    }
  }
});

test("writing a blue-force asset requires Commander; Analyst is refused", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  let createdId: string | undefined;
  t.after(async () => {
    if (createdId) await deleteBlueForceAsset(db, createdId);
    await app.close();
    await db.$client.end();
  });

  const body = {
    callsign: `NW005-${Date.now()}`,
    classification: "FRIENDLY",
    position: { lat: 10, lon: 10, alt_m: 0 },
    buffer_radius_m: 500,
  };

  const forbidden = await app.inject({
    method: "POST",
    url: "/api/v1/blue-force-assets",
    headers: await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] }),
    payload: body,
  });
  assert.equal(forbidden.statusCode, 403);

  const allowed = await app.inject({
    method: "POST",
    url: "/api/v1/blue-force-assets",
    headers: await testAuth.authHeader({ sub: "cdr-1", roles: ["Commander"] }),
    payload: body,
  });
  assert.equal(allowed.statusCode, 200);
  createdId = allowed.json().asset_id as string;
  assert.ok(createdId);
});

test("creating and deleting a no-strike zone requires Commander", async (t) => {
  const db = createDb(DATABASE_URL);
  const testAuth = await createTestAuth();
  const app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const zoneBody = {
    name: `NW005 zone ${Date.now()}`,
    polygon: [
      [10, 10],
      [10, 10.01],
      [10.01, 10.01],
      [10, 10],
    ],
  };

  // A Field Operator can read the zones (previous test) but must not be
  // able to remove the protection they represent.
  const forbiddenCreate = await app.inject({
    method: "POST",
    url: "/api/v1/no-strike-zones",
    headers: await testAuth.authHeader({ sub: "fo-1", roles: ["Field Operator"] }),
    payload: zoneBody,
  });
  assert.equal(forbiddenCreate.statusCode, 403);

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/no-strike-zones",
    headers: await testAuth.authHeader({ sub: "cdr-1", roles: ["Commander"] }),
    payload: zoneBody,
  });
  assert.equal(created.statusCode, 200);
  const zoneId = created.json().zone_id as string;

  const forbiddenDelete = await app.inject({
    method: "DELETE",
    url: `/api/v1/no-strike-zones/${zoneId}`,
    headers: await testAuth.authHeader({ sub: "viewer-1", roles: ["Viewer"] }),
  });
  assert.equal(forbiddenDelete.statusCode, 403);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/v1/no-strike-zones/${zoneId}`,
    headers: await testAuth.authHeader({ sub: "admin-1", roles: ["SuperAdmin"] }),
  });
  assert.equal(deleted.statusCode, 204, "SuperAdmin satisfies a 'commander' requirement");
});
