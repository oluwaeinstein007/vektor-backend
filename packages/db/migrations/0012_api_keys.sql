-- NW-017: integrator API keys (Epic 9, persona 7, REQ-8.5).
--
-- HAND-WRITTEN rather than generated, for the RLS policy's
-- `current_setting()` predicate and the partial index below, neither of
-- which drizzle-kit's schema DSL can express.
--
-- Depends on 0011: `org_id` references `organisations`, and the isolation
-- policy reads the same `vektor.org_id` setting every other scoped table
-- does. An API key that could act across organisations would make NW-015's
-- whole scoping story decorative, since a key is the credential most likely
-- to be handed to a third party.

CREATE TABLE IF NOT EXISTS "api_keys" (
	"key_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"role" text DEFAULT 'Viewer' NOT NULL,
	"rate_limit_per_min" integer DEFAULT 60 NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" timestamptz,
	"expires_at" timestamptz,
	"revoked_at" timestamptz,
	CONSTRAINT "api_keys_key_prefix_unique" UNIQUE ("key_prefix")
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_org_id_fk') THEN
    ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "organisations"("org_id");
  END IF;
END
$$;--> statement-breakpoint

-- Listing an organisation's keys is the common console query.
CREATE INDEX IF NOT EXISTS "api_keys_org_idx" ON "api_keys" ("org_id");--> statement-breakpoint

-- The verification path looks a key up by prefix and only cares about ones
-- that are still usable. Partial, because revoked keys accumulate forever
-- by design (revocation is a timestamp, not a DELETE, so the audit trail
-- survives) and there is no reason for them to keep bloating the index
-- that every authenticated API request consults.
--
-- `revoked_at IS NULL` only — NOT `expires_at`. An expiry predicate would
-- not be immutable (it would have to compare against now()), so Postgres
-- rejects it in an index. Expiry is checked in code; see verifyApiKey.
CREATE INDEX IF NOT EXISTS "api_keys_active_prefix_idx"
  ON "api_keys" ("key_prefix") WHERE "revoked_at" IS NULL;--> statement-breakpoint

-- Same organisation isolation as every other scoped table (0011).
--
-- NOTE for whoever wires the loader: authentication must read this table
-- WITHOUT an organisation scope, because the request has no organisation
-- until the key has been resolved — the key is what determines it. That
-- lookup therefore runs as the owner connection, not as `vektor_app`, and
-- it is the one deliberate exception to scoping everything. It is safe
-- because the lookup is by a unique prefix and returns at most one row,
-- and because possession of the secret is what authorises anything.
-- Everything AFTER authentication is scoped normally.
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "api_keys_org_isolation" ON "api_keys";--> statement-breakpoint
CREATE POLICY "api_keys_org_isolation" ON "api_keys" AS PERMISSIVE FOR ALL TO "vektor_app"
  USING (org_id = current_setting('vektor.org_id')::uuid)
  WITH CHECK (org_id = current_setting('vektor.org_id')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "api_keys" TO "vektor_app";
