// SEC-003: verifies the audit_log RLS policies (schema/auditLog.ts) against
// a real Postgres instance — not a mock, and not just "the migration ran
// without error." A non-owner, non-superuser role is the only way to
// observe RLS actually doing anything (it never applies to the table owner
// or to a superuser connection), so this test provisions one for real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createDb, type VektorDb } from "../src/client.js";
import { auditLog } from "../src/schema/auditLog.js";

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
  appDb = createDb(appRoleUrl.toString());
});

after(async () => {
  await appDb.$client.end();
  await adminSql.end();
});

test("vektor_app can SELECT and INSERT into audit_log", async () => {
  const [inserted] = await appDb
    .insert(auditLog)
    .values({ actor_user_id: "rls-test-insert", actor_role: "SuperAdmin", action: "rls.test", resource_type: "test" })
    .returning();
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

  await assert.rejects(
    () => appDb.$client`UPDATE audit_log SET action = 'tampered' WHERE actor_user_id = 'rls-test-update'`,
    /permission denied/,
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

  await assert.rejects(
    () => appDb.$client`DELETE FROM audit_log WHERE actor_user_id = 'rls-test-delete'`,
    /permission denied/,
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
