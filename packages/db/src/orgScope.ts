// packages/db/src/orgScope.ts — NW-015, the scoping primitive.
//
// RLS needs to know which organisation the current statement belongs to.
// Postgres's only mechanism for "a value the policy can read, set by the
// application, per connection" is a run-time configuration parameter, so
// that is what the policies read: `current_setting('vektor.org_id')`.
//
// Three properties this file exists to guarantee:
//
// 1. **SET LOCAL, never SET.** A plain SET persists for the life of the
//    connection, and every service here uses a postgres.js POOL. A pooled
//    connection returned to the pool still carrying org A's id, then handed
//    to a request for org B, is a cross-tenant data leak that would pass
//    every test written against a single org. SET LOCAL is scoped to the
//    surrounding transaction and is reverted on COMMIT or ROLLBACK, which
//    is why every call here is wrapped in one.
//
// 2. **No string interpolation.** `SET LOCAL` does not accept a bind
//    parameter, which is the usual reason this gets written as string
//    concatenation and becomes an injection site. `set_config()` is the
//    function form and DOES take parameters, so the org id goes in as a
//    bound value like any other.
//
// 3. **Fails closed.** The policies use `current_setting('vektor.org_id')`
//    with no `missing_ok`, so an unscoped statement raises rather than
//    quietly matching nothing. A policy that silently returns zero rows
//    when the GUC is unset looks identical to "this org genuinely has no
//    data", and that is the failure mode that gets shipped.
import { sql } from "drizzle-orm";
import type { VektorDb } from "./client.js";

/** The GUC the RLS policies read. `vektor.` prefix because Postgres requires custom parameters to be namespaced. */
export const ORG_SCOPE_SETTING = "vektor.org_id";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OrgScopeError extends Error {}

/**
 * Runs `fn` inside a transaction scoped to `orgId`.
 *
 * Every statement `fn` issues sees only that organisation's rows, enforced
 * by Postgres rather than by remembering to add `WHERE org_id = ...` — the
 * point being that a forgotten WHERE clause is a leak, whereas a forgotten
 * `withOrgScope` is an error.
 *
 * Note this is inert for a connection that owns the tables or is a
 * superuser: Postgres never applies RLS to either, and every DATABASE_URL
 * in this repo's dev/test config still connects as `postgres`. That is the
 * same documented deployment gap SEC-003 left on audit_log — see
 * schema/auditLog.ts — and closing it means switching service connection
 * identities to `vektor_app`, not changing this function.
 */
export async function withOrgScope<T>(db: VektorDb, orgId: string, fn: (tx: VektorDb) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) {
    // Checked before it reaches the database because a malformed value
    // would otherwise surface as a cast error from deep inside a policy
    // evaluation, naming neither the caller nor the org.
    throw new OrgScopeError(`org id is not a uuid: ${JSON.stringify(orgId)}`);
  }

  return db.transaction(async (tx) => {
    // `true` is set_config's is_local argument — the function form of
    // SET LOCAL. Reverted when this transaction ends, however it ends.
    await tx.execute(sql`SELECT set_config(${ORG_SCOPE_SETTING}, ${orgId}, true)`);
    return fn(tx as unknown as VektorDb);
  });
}

/**
 * The org id the current transaction is scoped to, as Postgres sees it.
 * Returns undefined when unscoped. Diagnostic — the policies do not call
 * this, they read the setting directly.
 */
export async function currentOrgScope(db: VektorDb): Promise<string | undefined> {
  const rows = (await db.execute(
    sql`SELECT current_setting(${ORG_SCOPE_SETTING}, true) AS org_id`,
  )) as unknown as { org_id: string | null }[];
  const value = rows[0]?.org_id;
  // Postgres reports a custom GUC that was SET LOCAL and then reverted as
  // the EMPTY STRING, not as NULL — the parameter now exists on the
  // session, it simply has no value. Treating '' as "still scoped" would
  // make a leaked scope look like a live one, which is the exact thing
  // this function is used to rule out.
  return value === null || value === undefined || value === "" ? undefined : value;
}
