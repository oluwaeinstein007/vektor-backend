// NW-015: verifies organisation isolation against a real Postgres, through
// a real non-owner role, with two real organisations' rows in the same
// tables. Same reasoning as rls.test.ts beside it: RLS never applies to a
// table's owner or a superuser, so a test that connects as `postgres`
// proves nothing at all about isolation. It would pass with no policies.
//
// The interesting assertions here are the negative ones — that an unscoped
// query RAISES rather than returning an empty set, and that a scoped
// connection cannot write a row attributed to another organisation. Both
// are failure modes that a "does org A see its own data" test passes while
// the system is wide open.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { createDb, type VektorDb } from "../src/client.js";
import { withOrgScope, currentOrgScope, OrgScopeError, ORG_SCOPE_SETTING } from "../src/orgScope.js";
import { DEFAULT_ORG_ID } from "../src/schema/orgConstants.js";
import { entities } from "../src/schema/entities.js";
import { eq, sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const APP_ROLE_PASSWORD = "vektor_app_test_password";

const ORG_A = DEFAULT_ORG_ID;
const ORG_B = "00000000-0000-0000-0000-0000000000b2";

const appRoleUrl = new URL(DATABASE_URL);
appRoleUrl.username = "vektor_app";
appRoleUrl.password = APP_ROLE_PASSWORD;

/**
 * drizzle wraps every driver error: the wrapper's `message` is the SQL text
 * ("Failed query: select ..."), and the actual PostgresError — the one
 * carrying "invalid input syntax for type uuid" or "violates row-level
 * security policy" — hangs off `.cause`.
 *
 * So `assert.rejects(fn, /permission denied/)` does NOT test what it looks
 * like it tests; it matches against the SQL. That fails in both directions
 * and the second is the dangerous one:
 *   - the regexp doesn't match the SQL, and a correctly-rejected query
 *     reads as a broken assertion (merely annoying); or
 *   - the regexp DOES match the SQL by accident — `/delete/i` against a
 *     DELETE statement, `/entities/` against a query on that table — and
 *     the assertion passes for ANY rejection whatsoever, including one
 *     caused by a typo. A security test that cannot fail is
 *     indistinguishable from one that passes.
 * Hence a predicate that reaches into `.cause` rather than a bare regexp.
 */
function causeMatches(re: RegExp) {
  return (err: unknown) => {
    const cause = (err as { cause?: unknown } | null)?.cause;
    return re.test(String(cause ?? err));
  };
}

let adminSql: postgres.Sql;
let appDb: VektorDb;
let ownerDb: VektorDb;

before(async () => {
  adminSql = postgres(DATABASE_URL);

  const roleRows = await adminSql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vektor_app') AS exists
  `;
  if (!roleRows[0]!.exists) {
    await adminSql.unsafe(`CREATE ROLE vektor_app LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
  } else {
    await adminSql.unsafe(`ALTER ROLE vektor_app LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
  }

  // A second organisation to be isolated *from*. Inserted by the owner:
  // the organisations policies deliberately forbid vektor_app from
  // provisioning one.
  await adminSql`
    INSERT INTO organisations (org_id, slug, name)
    VALUES (${ORG_B}, 'orgscope-test-b', 'Org Scope Test B')
    ON CONFLICT (org_id) DO NOTHING
  `;

  // One entity in each organisation, same classification so neither can be
  // told from the other by anything except org_id.
  //
  // Clears every `orgscope-*` row first, not just this test's: a previous
  // run that failed mid-way leaves rows that make the NEGATIVE assertions
  // here ("no row leaked", "the audit row is still there, exactly once")
  // fail for the wrong reason, which reads as a security regression.
  await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'orgscope-audit'`;
  await adminSql`DELETE FROM entities WHERE classification LIKE 'orgscope-%'`;
  await adminSql`
    INSERT INTO entities (org_id, classification, confidence)
    VALUES (${ORG_A}, 'orgscope-fixture', 0.9), (${ORG_B}, 'orgscope-fixture', 0.9)
  `;

  appDb = createDb(appRoleUrl.toString());
  ownerDb = createDb(DATABASE_URL);
});

after(async () => {
  // try/finally, and children before parents. A failing assertion leaves
  // rows behind; those rows hold a FK to the test organisation; deleting
  // the organisation then throws, the connection-close lines below never
  // run, and node:test hangs forever on the open handles instead of
  // reporting which assertion failed. Diagnosing that costs far more than
  // this block does.
  try {
    await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'orgscope-audit'`;
    await adminSql`DELETE FROM entities WHERE classification LIKE 'orgscope-%'`;
    await adminSql`DELETE FROM organisations WHERE org_id = ${ORG_B}`;
  } finally {
    await appDb.$client.end();
    await ownerDb.$client.end();
    await adminSql.end();
  }
});

test("withOrgScope sets the GUC the policies read, and only inside its transaction", async () => {
  const inside = await withOrgScope(ownerDb, ORG_B, async (tx) => currentOrgScope(tx));
  assert.equal(inside, ORG_B);

  // set_config(..., is_local = true) is reverted when the transaction ends.
  // If this ever returns ORG_B, the scope is leaking onto a pooled
  // connection and the next request on it reads the wrong tenant's data.
  const outside = await currentOrgScope(ownerDb);
  assert.equal(outside, undefined);
});

test("a scoped vektor_app connection sees only its own organisation's rows", async () => {
  const seenByA = await withOrgScope(appDb, ORG_A, async (tx) =>
    tx.select().from(entities).where(eq(entities.classification, "orgscope-fixture")),
  );
  assert.equal(seenByA.length, 1);
  assert.equal(seenByA[0]!.org_id, ORG_A);

  const seenByB = await withOrgScope(appDb, ORG_B, async (tx) =>
    tx.select().from(entities).where(eq(entities.classification, "orgscope-fixture")),
  );
  assert.equal(seenByB.length, 1);
  assert.equal(seenByB[0]!.org_id, ORG_B);

  // Both rows are really there — the isolation above is RLS filtering, not
  // a fixture that only ever inserted one row.
  const seenByOwner = await adminSql`SELECT org_id FROM entities WHERE classification = 'orgscope-fixture'`;
  assert.equal(seenByOwner.length, 2);
});

test("an UNSCOPED query raises rather than quietly returning nothing", async () => {
  // The whole point of calling current_setting() without missing_ok. If
  // this returned [] instead of throwing, a service that forgot to scope
  // would look exactly like a tenant with no data, and would ship.
  //
  // Two distinct Postgres errors satisfy this, and which one you get
  // depends on whether the pooled connection has EVER been scoped:
  //   - never scoped: `unrecognized configuration parameter "vektor.org_id"`
  //   - scoped earlier, transaction ended: the parameter now exists with
  //     the empty string as its value, and `''::uuid` raises
  //     `invalid input syntax for type uuid: ""`.
  // Both fail closed, which is the property under test; accepting only the
  // first would make this pass or fail depending on connection history.
  await assert.rejects(
    () => appDb.select().from(entities).where(eq(entities.classification, "orgscope-fixture")),
    causeMatches(/unrecognized configuration parameter|invalid input syntax for type uuid/i),
  );
});

test("a scoped connection cannot write a row attributed to another organisation", async () => {
  // WITH CHECK, not just USING. A policy with only USING filters reads and
  // lets a tenant insert rows into someone else's organisation — which is
  // worse than a read leak, because it is persistent and attributable to
  // the victim.
  await assert.rejects(
    () =>
      withOrgScope(appDb, ORG_A, async (tx) => {
        await tx.insert(entities).values({
          org_id: ORG_B,
          classification: "orgscope-cross-write",
          confidence: 0.5,
        });
      }),
    causeMatches(/row-level security/i),
  );

  const leaked = await adminSql`SELECT 1 FROM entities WHERE classification = 'orgscope-cross-write'`;
  assert.equal(leaked.length, 0);
});

test("a scoped connection CAN write to its own organisation", async () => {
  await withOrgScope(appDb, ORG_B, async (tx) => {
    await tx.insert(entities).values({
      org_id: ORG_B,
      classification: "orgscope-own-write",
      confidence: 0.5,
    });
  });

  const rows = await adminSql`SELECT org_id FROM entities WHERE classification = 'orgscope-own-write'`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.org_id, ORG_B);

  await adminSql`DELETE FROM entities WHERE classification = 'orgscope-own-write'`;
});

test("org_id defaults to the default organisation, so pre-NW-015 inserts still work", async () => {
  // The single-tenant no-op property: an INSERT that has never heard of
  // organisations lands in the default one rather than failing NOT NULL.
  const [row] = await adminSql<{ org_id: string }[]>`
    INSERT INTO entities (classification, confidence)
    VALUES ('orgscope-default', 0.5)
    RETURNING org_id
  `;
  assert.equal(row!.org_id, DEFAULT_ORG_ID);
  await adminSql`DELETE FROM entities WHERE classification = 'orgscope-default'`;
});

test("withOrgScope rejects a non-uuid before it reaches the database", async () => {
  await assert.rejects(
    () => withOrgScope(ownerDb, "default", async () => undefined),
    (err: unknown) => err instanceof OrgScopeError,
  );
  // Guards the seam with NW-016's metering, which carries org_id as an
  // opaque text column: the sentinel there must be a uuid-shaped string,
  // not the literal "default", or the eventual ::uuid conversion fails on
  // every accumulated row.
  assert.equal(ORG_SCOPE_SETTING, "vektor.org_id");
});

test("audit_log stays append-only AND becomes org-scoped (0007's guarantee survives 0011)", async () => {
  // Adding a permissive FOR ALL policy to audit_log would have OR-ed with
  // audit_log_no_update/no_delete and silently restored the ability to
  // tamper with the audit trail. 0011 replaces the two read/write policies
  // in place instead; this asserts both properties at once.
  await adminSql`
    INSERT INTO audit_log (org_id, actor_user_id, actor_role, action, resource_type)
    VALUES (${ORG_B}, 'orgscope-audit', 'SuperAdmin', 'orgscope.test', 'test')
  `;

  const visibleToA = await withOrgScope(appDb, ORG_A, async (tx) =>
    tx.execute(sql`SELECT 1 FROM audit_log WHERE actor_user_id = 'orgscope-audit'`),
  );
  assert.equal((visibleToA as unknown as unknown[]).length, 0, "org A must not see org B's audit rows");

  await assert.rejects(
    () =>
      withOrgScope(appDb, ORG_B, async (tx) =>
        tx.execute(sql`DELETE FROM audit_log WHERE actor_user_id = 'orgscope-audit'`),
      ),
    causeMatches(/permission denied|row-level security/i),
  );

  const still = await adminSql`SELECT 1 FROM audit_log WHERE actor_user_id = 'orgscope-audit'`;
  assert.equal(still.length, 1);

  await adminSql`DELETE FROM audit_log WHERE actor_user_id = 'orgscope-audit'`;
});
