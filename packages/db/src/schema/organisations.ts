// packages/db/src/schema/organisations.ts — NW-015, organisation scoping.
//
// 17-next-work.md frames NW-015 as a question before it is a task: VEKTOR
// may be right to STAY single-tenant and lean into self-hosted and edge
// appliances (18-use-cases.md's two strongest verticals are both shaped
// that way). This table does not answer that question and is not meant to.
// It makes the answer cheap in either direction:
//
//   - Single-tenant deployments get exactly one organisation — the default
//     one seeded by the migration — and never think about this again. Every
//     `org_id` column defaults to it, so no service, query or test changes.
//   - Hosted multi-tenant becomes a configuration and rollout problem
//     rather than a schema migration across fifteen tables with live data
//     in them, which is the version of this that is genuinely hard.
//
// The expensive, irreversible half of multi-tenancy is retrofitting a
// tenant key onto existing rows. Doing it now, while the default makes it a
// no-op, is what buys the option.
import { pgTable, pgPolicy, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vektorAppRole } from "./auditLog.js";

/**
 * The organisation every existing row belongs to, and the default for every
 * `org_id` column. Fixed rather than generated so that a fresh database and
 * a migrated one agree on it — a generated default would make the same
 * logical row carry a different org_id in dev and in production, which
 * breaks fixtures, backups restored across environments, and any support
 * query that quotes an id.
 *
 * Defined in `orgConstants.ts` and re-exported here so this module stays
 * the obvious place to look for it; see that file for why it cannot live
 * here directly.
 */
export { DEFAULT_ORG_ID } from "./orgConstants.js";

export const organisations = pgTable(
  "organisations",
  {
    org_id: uuid("org_id").primaryKey().defaultRandom(),
    /** URL//topic-safe short name. Unique; what an operator actually types. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    /**
     * ACTIVE | SUSPENDED. Suspension is deliberately NOT deletion: an
     * organisation's data outlives its subscription (audit obligations,
     * NW-016 billing disputes, 33 CFR 105.250-style retention duties), and
     * a status flag keeps the rows addressable while the scoping layer
     * refuses new work for them.
     */
    status: text("status").notNull().default("ACTIVE"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    // The org directory itself is readable by any scoped connection — a
    // service needs to resolve its own org's name and status. It is not
    // writable: provisioning an organisation is a control-plane action, not
    // something a data-plane service can do with its own credential.
    pgPolicy("organisations_select_all", { for: "select", to: vektorAppRole, using: sql`true` }),
    pgPolicy("organisations_no_insert", { for: "insert", to: vektorAppRole, withCheck: sql`false` }),
    pgPolicy("organisations_no_update", { for: "update", to: vektorAppRole, using: sql`false` }),
    pgPolicy("organisations_no_delete", { for: "delete", to: vektorAppRole, using: sql`false` }),
  ],
).enableRLS();
