import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import { buildApp } from "../src/app.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("POST /api/v1/audit writes an entry; GET /api/v1/audit retrieves it", async (t) => {
  const db = createDb(DATABASE_URL);
  const app = buildApp({ db, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const actorId = `route-test-${Date.now()}`;
  const writeRes = await app.inject({
    method: "POST",
    url: "/api/v1/audit",
    payload: {
      actor_user_id: actorId,
      actor_role: "Commander",
      action: "coa.approve",
      resource_type: "coa",
      resource_id: "00000000-0000-0000-0000-000000000099",
      metadata: { option_rank: 2 },
    },
  });
  assert.equal(writeRes.statusCode, 200);
  const written = writeRes.json();
  assert.equal(written.actor_user_id, actorId);
  assert.ok(written.audit_id);

  const listRes = await app.inject({ method: "GET", url: `/api/v1/audit?actor_user_id=${actorId}` });
  assert.equal(listRes.statusCode, 200);
  const list = listRes.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].audit_id, written.audit_id);
});

test("GET /api/v1/audit with no matching filter returns an empty array", async (t) => {
  const db = createDb(DATABASE_URL);
  const app = buildApp({ db, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({ method: "GET", url: "/api/v1/audit?actor_user_id=nonexistent-actor-xyz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
});

test("POST /api/v1/audit rejects a body missing required fields", async (t) => {
  const db = createDb(DATABASE_URL);
  const app = buildApp({ db, logger: false });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({ method: "POST", url: "/api/v1/audit", payload: { actor_user_id: "x" } });
  assert.equal(res.statusCode, 400);
});
