import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import { insertAuditEntry, listAuditEntries } from "../src/db/queries.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("insertAuditEntry persists and is retrievable via listAuditEntries", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const actorId = `test-actor-${Date.now()}`;
  const row = await insertAuditEntry(db, {
    actor_user_id: actorId,
    actor_role: "Commander",
    action: "coa.approve",
    resource_type: "coa",
    resource_id: "00000000-0000-0000-0000-000000000001",
    metadata: { option_rank: 1 },
  });

  assert.ok(row.audit_id);
  assert.equal(row.actor_user_id, actorId);

  const results = await listAuditEntries(db, { actor_user_id: actorId });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.audit_id, row.audit_id);
});

test("listAuditEntries filters by action", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const actorId = `test-actor-${Date.now()}`;
  await insertAuditEntry(db, {
    actor_user_id: actorId,
    actor_role: "Commander",
    action: "coa.approve",
    resource_type: "coa",
    resource_id: null,
  });
  await insertAuditEntry(db, {
    actor_user_id: actorId,
    actor_role: "Commander",
    action: "coa.reject",
    resource_type: "coa",
    resource_id: null,
  });

  const approvals = await listAuditEntries(db, { actor_user_id: actorId, action: "coa.approve" });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.action, "coa.approve");
});

test("listAuditEntries orders newest first", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const actorId = `test-actor-order-${Date.now()}`;
  const first = await insertAuditEntry(db, {
    actor_user_id: actorId,
    actor_role: "Analyst",
    action: "sensor.register",
    resource_type: "sensor",
    resource_id: null,
  });
  await new Promise((r) => setTimeout(r, 10));
  const second = await insertAuditEntry(db, {
    actor_user_id: actorId,
    actor_role: "Analyst",
    action: "sensor.register",
    resource_type: "sensor",
    resource_id: null,
  });

  const results = await listAuditEntries(db, { actor_user_id: actorId });
  assert.equal(results[0]!.audit_id, second.audit_id);
  assert.equal(results[1]!.audit_id, first.audit_id);
});

test("metadata defaults to an empty object when omitted", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const row = await insertAuditEntry(db, {
    actor_user_id: `test-actor-meta-${Date.now()}`,
    actor_role: "SuperAdmin",
    action: "model.upload",
    resource_type: "model",
    resource_id: null,
  });
  assert.deepEqual(row.metadata, {});
});
