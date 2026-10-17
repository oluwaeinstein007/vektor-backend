// packages/db/src/schema/apiKeys.ts — NW-017, Epic 9 / persona 7
// (Systems Integrator), REQ-8.5.
//
// Today the only way into the public API is a human Keycloak JWT. That is
// fine for an operator at a console and useless for an integration: a
// third-party system has no human to log in as, no browser to redirect, and
// needs a credential that can be scoped narrowly, rate-limited
// independently and revoked without disturbing anyone else.
//
// Deliberately NOT OAuth2 client-credentials against Keycloak, which is
// what REQ-8.5 names. That would mean every integrator becoming a Keycloak
// client, provisioned through Keycloak's admin API, with VEKTOR owning none
// of the rate limiting or the scope vocabulary — and it makes the edge
// profile, which runs with no Keycloak at all, unable to authenticate an
// integration. An API key the platform issues and verifies itself keeps
// both deployment shapes working from one code path. The Keycloak route
// stays open as an additional issuer later; it is not a prerequisite.
import { pgTable, pgPolicy, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vektorAppRole } from "./auditLog.js";
import { DEFAULT_ORG_ID } from "./orgConstants.js";

export const apiKeys = pgTable(
  "api_keys",
  {
    key_id: uuid("key_id").primaryKey().defaultRandom(),

    /**
     * NW-015. An API key belongs to exactly one organisation and can never
     * act outside it — this is the column that makes "scoped key" mean
     * something, and it is why NW-017 had to wait for NW-015 rather than
     * inventing a second, parallel notion of tenancy.
     */
    org_id: uuid("org_id").notNull().default(DEFAULT_ORG_ID),

    /** Human label, shown in a key list. Not unique — people reuse names. */
    name: text("name").notNull(),

    /**
     * The public half of the credential, stored in clear and indexed. A
     * presented key is split into (prefix, secret); the prefix finds the
     * row, the secret is then compared against `secret_hash`. Without a
     * separate prefix the only way to verify would be to hash the
     * presented secret against EVERY row, which is O(keys) per request.
     */
    key_prefix: text("key_prefix").notNull().unique(),

    /**
     * SHA-256 of the secret half, hex. Not argon2/bcrypt, and that is a
     * considered choice rather than an oversight: those exist to make
     * LOW-entropy human passwords expensive to brute-force. This secret is
     * 256 bits from a CSPRNG, so there is nothing to brute-force, and a
     * deliberately slow KDF on the hot path of every API request would be a
     * self-inflicted rate limit. The comparison is timing-safe.
     */
    secret_hash: text("secret_hash").notNull(),

    /**
     * What this key may do, e.g. `entities:read`, `coa:write`. Empty means
     * no access rather than full access — a key with no scopes is useless,
     * which is the correct default for a credential whose scopes someone
     * forgot to set.
     */
    scopes: text("scopes").array().notNull().default([]),

    /**
     * The VEKTOR role this key acts as, so the existing `requireRole()`
     * checks on every route keep working unchanged for key-authenticated
     * requests. Scopes narrow further; they never widen past this role.
     */
    role: text("role").notNull().default("Viewer"),

    /** Requests per minute. Enforced per key, not per organisation. */
    rate_limit_per_min: integer("rate_limit_per_min").notNull().default(60),

    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    created_by: text("created_by").notNull(),

    /**
     * Updated opportunistically, not on the request path — a write per
     * request would double the database traffic of every integration call
     * to maintain a field nothing reads synchronously.
     */
    last_used_at: timestamp("last_used_at", { withTimezone: true }),

    /** Null means "never expires". An expiry is advisory until checked. */
    expires_at: timestamp("expires_at", { withTimezone: true }),

    /**
     * Revocation is a timestamp, not a DELETE. REQ-8.5 wants a revocation
     * path; an audit trail wants to still answer "what did key X do, and
     * when did it stop being valid" afterwards. A deleted row answers
     * neither.
     */
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
  },
  () => [
    pgPolicy("api_keys_org_isolation", {
      for: "all",
      to: vektorAppRole,
      using: sql`org_id = current_setting('vektor.org_id')::uuid`,
      withCheck: sql`org_id = current_setting('vektor.org_id')::uuid`,
    }),
  ],
).enableRLS();
