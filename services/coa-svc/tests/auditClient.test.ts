// Real round-trip: a real audit-svc Fastify instance bound to an ephemeral
// port, and coa-svc's fetch-based AuditClient talking to it over real HTTP
// — not a mocked fetch. audit-svc's own package can't be imported directly
// from here (separate service, no workspace dependency between the two
// coa-svc/audit-svc packages), so this spins up audit-svc's compiled
// dist/src/app.js the same way its own tests do, via a plain child process
// listening on a fixed test port; simpler alternative used here instead:
// audit-svc's dist output is invoked in-process via a relative import,
// since both services live in the same pnpm workspace checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import { createAuditClient } from "../src/audit/client.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

// A relative string literal here can't satisfy both TS (which resolves a
// dynamic-import literal against this *source* file's location, tests/) and
// Node at runtime (which resolves against the *compiled* file's location,
// dist/tests/ — a different depth relative to the sibling audit-svc
// package). Building the specifier from import.meta.url instead sidesteps
// both problems: TS treats a non-literal specifier as untyped (no false
// compile error), and it's correct at runtime regardless of which depth the
// running file actually lives at.
const AUDIT_SVC_APP_PATH = new URL("../../../audit-svc/dist/src/app.js", import.meta.url).href;

test("createAuditClient().write() round-trips through a real audit-svc HTTP instance", async (t) => {
  const { buildApp } = await import(AUDIT_SVC_APP_PATH);
  const db = createDb(DATABASE_URL);
  const { authOptions } = await createTestAuth();
  const auditApp = buildApp({ db, auth: authOptions, logger: false });
  await auditApp.listen({ port: 0, host: "127.0.0.1" });
  const address = auditApp.server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");

  t.after(async () => {
    await auditApp.close();
    await db.$client.end();
  });

  const client = createAuditClient(`http://127.0.0.1:${address.port}`);
  const entry = await client.write({
    actor_user_id: "cdr-e2e",
    actor_role: "Commander",
    action: "coa.approve",
    resource_type: "coa",
    resource_id: "55555555-5555-5555-5555-555555555555",
    metadata: { option_rank: 1 },
  });

  assert.equal(entry.actor_user_id, "cdr-e2e");
  assert.equal(entry.action, "coa.approve");
  assert.ok(entry.audit_id.length > 0);
});
