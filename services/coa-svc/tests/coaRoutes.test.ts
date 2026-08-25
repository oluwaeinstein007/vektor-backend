import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@vektor/db";
import { createQdrantClient } from "@vektor/qdrant";
import { buildApp } from "../src/app.js";
import { insertCoa } from "../src/db/coaQueries.js";
import type { AuditClient } from "../src/audit/client.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:16333";

const VALID_OPTION = {
  rank: 1,
  title: "Reposition ISR asset",
  rationale: "Maintain track custody without closing distance.",
  confidence: 0.8,
  required_assets: ["UAS-1"],
  estimated_duration_min: 15,
  context_factors: ["closing_velocity"],
};

function fakeAuditClient(): { client: AuditClient; writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    client: {
      async write(entry) {
        writes.push(entry);
        return {
          audit_id: "00000000-0000-0000-0000-00000000aaaa",
          ts: new Date().toISOString(),
          ...entry,
          resource_id: entry.resource_id,
          metadata: entry.metadata ?? {},
        };
      },
    },
  };
}

test("GET /api/v1/coa/:situation_id returns previously generated COAs for that situation", async (t) => {
  const db = createDb(DATABASE_URL);
  const qdrant = createQdrantClient(QDRANT_URL);
  const { client: auditClient } = fakeAuditClient();
  const app = buildApp({
    db,
    qdrant,
    mode: { kind: "edge", modelPath: "/nonexistent" }, // not exercised by this test
    auditSvcUrl: "http://unused",
    fusionSvcUrl: "http://unused",
    logger: false,
    auditClient,
  });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  // A fresh UUID per run, not a fixed literal — insertCoa doesn't enforce
  // situation_id uniqueness, so a hardcoded value accumulates extra rows
  // in this real, persistent Postgres instance across repeated test runs
  // and breaks this test's `length === 1` assertion on the second run.
  const situationId = randomUUID();
  await insertCoa(db, { situation_id: situationId, options: [VALID_OPTION] });

  const res = await app.inject({ method: "GET", url: `/api/v1/coa/${situationId}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].situation_id, situationId);
  assert.equal(body[0].status, "PENDING");
});

test("POST /api/v1/coa/:coa_id/approve sets status/selected_option and writes an audit entry", async (t) => {
  const db = createDb(DATABASE_URL);
  const qdrant = createQdrantClient(QDRANT_URL);
  const { client: auditClient, writes } = fakeAuditClient();
  const app = buildApp({
    db,
    qdrant,
    mode: { kind: "edge", modelPath: "/nonexistent" },
    auditSvcUrl: "http://unused",
    fusionSvcUrl: "http://unused",
    logger: false,
    auditClient,
  });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const row = await insertCoa(db, { situation_id: randomUUID(), options: [VALID_OPTION] });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/coa/${row.coa_id}/approve`,
    payload: { option_rank: 1, notes: "Approved for execution", actor_user_id: "cdr-1", actor_role: "Commander" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "APPROVED");
  assert.equal(body.selected_option, 1);
  assert.equal(body.commander_notes, "Approved for execution");

  assert.equal(writes.length, 1);
  assert.equal((writes[0] as { action: string }).action, "coa.approve");
});

test("POST /api/v1/coa/:coa_id/reject sets status REJECTED and writes an audit entry", async (t) => {
  const db = createDb(DATABASE_URL);
  const qdrant = createQdrantClient(QDRANT_URL);
  const { client: auditClient, writes } = fakeAuditClient();
  const app = buildApp({
    db,
    qdrant,
    mode: { kind: "edge", modelPath: "/nonexistent" },
    auditSvcUrl: "http://unused",
    fusionSvcUrl: "http://unused",
    logger: false,
    auditClient,
  });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const row = await insertCoa(db, { situation_id: randomUUID(), options: [VALID_OPTION] });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/coa/${row.coa_id}/reject`,
    payload: { reason: "Insufficient asset availability", actor_user_id: "cdr-1", actor_role: "Commander" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "REJECTED");
  assert.equal(body.selected_option, null);

  assert.equal(writes.length, 1);
  assert.equal((writes[0] as { action: string }).action, "coa.reject");
});

test("POST /api/v1/coa/:coa_id/approve on a nonexistent coa_id returns 404", async (t) => {
  const db = createDb(DATABASE_URL);
  const qdrant = createQdrantClient(QDRANT_URL);
  const { client: auditClient } = fakeAuditClient();
  const app = buildApp({
    db,
    qdrant,
    mode: { kind: "edge", modelPath: "/nonexistent" },
    auditSvcUrl: "http://unused",
    fusionSvcUrl: "http://unused",
    logger: false,
    auditClient,
  });
  t.after(async () => {
    await app.close();
    await db.$client.end();
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/coa/44444444-4444-4444-4444-444444444444/approve",
    payload: { option_rank: 1, notes: null, actor_user_id: "cdr-1", actor_role: "Commander" },
  });
  assert.equal(res.statusCode, 404);
});
