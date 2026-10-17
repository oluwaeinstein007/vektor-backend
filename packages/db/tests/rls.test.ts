// SEC-003: verifies the audit_log RLS policies (schema/auditLog.ts) against
// a real Postgres instance — not a mock, and not just "the migration ran
// without error." A non-owner, non-superuser role is the only way to
// observe RLS actually doing anything (it never applies to the table owner
// or to a superuser connection), so this test provisions one for real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { createDb, type VektorDb } from "../src/client.js";
import { auditLog } from "../src/schema/auditLog.js";
import { withOrgScope } from "../src/orgScope.js";
import { DEFAULT_ORG_ID } from "../src/schema/orgConstants.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const APP_ROLE_PASSWORD = "vektor_app_test_password";

const url = new URL(DATABASE_URL);
const appRoleUrl = new URL(DATABASE_URL);
appRoleUrl.username = "vektor_app";
appRoleUrl.password = APP_ROLE_PASSWORD;

let adminSql: postgres.Sql;
let appDb: VektorDb;

before(async () => {
  adminSql = postgres(DATABASE_URL);

  // Idempotent: safe to re-run against a persistent shared dev Postgres.
  const roleCheckRows = await adminSql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vektor_app') AS exists
  `;
  if (!roleCheckRows[0]!.exists) {
    await adminSql.unsafe(`CREATE ROLE vektor_app LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
  } else {
    await adminSql.unsafe(`ALTER ROLE vektor_app LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
  }
  await adminSql.unsafe(`GRANT CONNECT ON DATABASE ${JSON.stringify(url.pathname.slice(1)).slice(1, -1)} TO vektor_app`);

  // Assumes migrations/0007_whole_alice.sql (ENABLE ROW LEVEL SECURITY +
  // the four audit_log policies + the SELECT/INSERT grant) has already been
  // applied to this database — same assumption every other test file in
  // this repo makes about schema state (nothing here runs migrations).
  // Clear anything a previous run left behind. These tests assert exact row
  // COUNTS ("still there, exactly once"), so a run that failed before its
  // own cleanup makes the next run fail on the count rather than on the
  // behaviour — which reads as the append-only guarantee having broken.
  await adminSql`DELETE FROM audit_log WHERE actor_user_id LIKE 'rls-test-%'`;

  appDb = createDb(appRoleUrl.toString());
});

after(async () => {
  await appDb.$client.end();
  await adminSql.end();
});

test("vektor_app can SELECT and INSERT into audit_log", async () => {
  // NW-015 changed this contract. 0011 replaced 0007's
  // `audit_log_select_all`/`insert_any` (both `USING (true)`) with
  // org-scoped equivalents, so an UNSCOPED insert now raises on
  // current_setting() instead of succeeding. The append-only guarantee this
  // file exists to prove is unchanged — it is asserted below — but every
  // statement reaching audit_log as vektor_app must now declare which
  // organisation it is acting for.
  const [inserted] = await withOrgScope(appDb, DEFAULT_ORG_ID, async (tx) =>
    tx
      .insert(auditLog)
      .values({ actor_user_id: "rls-test-insert", actor_role: "SuperAdmin", action: "rls.test", resource_type: "test" })
      .returning(),
  );
  assert.ok(inserted);

  const rows = await adminSql`SELECT * FROM audit_log WHERE actor_user_id = 'rls-test-insert'`;
  assert.equal(rows.length, 1);

  await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'rls-test-insert'`;
});

test("vektor_app cannot UPDATE audit_log — no grant, and the policy would reject it anyway", async () => {
  await adminSql`
    INSERT INTO audit_log (actor_user_id, actor_role, action, resource_type)
    VALUES ('rls-test-update', 'SuperAdmin', 'rls.test', 'test')
  `;

  // Org-scoped on purpose, and the reason is subtle. An UPDATE/DELETE on a
  // table with RLS enabled also evaluates that table's SELECT policy in
  // order to find its target rows, and 0011's SELECT policy casts
  // `current_setting('vektor.org_id')::uuid`. On a POOLED connection that
  // was scoped by some earlier transaction, the setting has reverted to the
  // empty string rather than becoming unset, so that cast raises
  // `invalid input syntax for type uuid: ""` BEFORE the privilege check
  // reports `permission denied`. Unscoped, this assertion therefore passes
  // or fails depending on what ran on the connection before it — which is
  // not a property worth testing. Scoped, the cast succeeds, the policy
  // evaluates, and the missing grant is what actually rejects the
  // statement, which is the guarantee this test is about.
  await assert.rejects(
    () =>
      withOrgScope(appDb, DEFAULT_ORG_ID, async (tx) =>
        tx.execute(sql`UPDATE audit_log SET action = 'tampered' WHERE actor_user_id = 'rls-test-update'`),
      ),
    (err: unknown) => /permission denied/.test(String((err as { cause?: unknown })?.cause ?? err)),
  );

  const [row] = await adminSql<{ action: string }[]>`
    SELECT action FROM audit_log WHERE actor_user_id = 'rls-test-update'
  `;
  assert.equal(row!.action, "rls.test"); // untouched

  await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'rls-test-update'`;
});

test("vektor_app cannot DELETE from audit_log — the append-only guarantee holds at the DB layer", async () => {
  await adminSql`
    INSERT INTO audit_log (actor_user_id, actor_role, action, resource_type)
    VALUES ('rls-test-delete', 'SuperAdmin', 'rls.test', 'test')
  `;

  // Org-scoped on purpose, and the reason is subtle. An UPDATE/DELETE on a
  // table with RLS enabled also evaluates that table's SELECT policy in
  // order to find its target rows, and 0011's SELECT policy casts
  // `current_setting('vektor.org_id')::uuid`. On a POOLED connection that
  // was scoped by some earlier transaction, the setting has reverted to the
  // empty string rather than becoming unset, so that cast raises
  // `invalid input syntax for type uuid: ""` BEFORE the privilege check
  // reports `permission denied`. Unscoped, this assertion therefore passes
  // or fails depending on what ran on the connection before it — which is
  // not a property worth testing. Scoped, the cast succeeds, the policy
  // evaluates, and the missing grant is what actually rejects the
  // statement, which is the guarantee this test is about.
  await assert.rejects(
    () =>
      withOrgScope(appDb, DEFAULT_ORG_ID, async (tx) =>
        tx.execute(sql`DELETE FROM audit_log WHERE actor_user_id = 'rls-test-delete'`),
      ),
    (err: unknown) => /permission denied/.test(String((err as { cause?: unknown })?.cause ?? err)),
  );

  const rows = await adminSql`SELECT 1 FROM audit_log WHERE actor_user_id = 'rls-test-delete'`;
  assert.equal(rows.length, 1); // still there

  await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'rls-test-delete'`;
});

test("the postgres superuser connection is unaffected by RLS (documented deployment gap)", async () => {
  // Demonstrates the exact limitation schema/auditLog.ts's comment
  // describes: RLS never applies to a superuser, so this UPDATE succeeds
  // even though the equivalent vektor_app UPDATE above is rejected. Closing
  // this gap means switching audit-svc's DATABASE_URL away from `postgres`
  // in deployment, not a change this migration can make by itself.
  await adminSql`
    INSERT INTO audit_log (actor_user_id, actor_role, action, resource_type)
    VALUES ('rls-test-superuser', 'SuperAdmin', 'rls.test', 'test')
  `;
  await adminSql`UPDATE audit_log SET action = 'superuser-can-still-do-this' WHERE actor_user_id = 'rls-test-superuser'`;
  const [row] = await adminSql<{ action: string }[]>`
    SELECT action FROM audit_log WHERE actor_user_id = 'rls-test-superuser'
  `;
  assert.equal(row!.action, "superuser-can-still-do-this");

  await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'rls-test-superuser'`;
});
