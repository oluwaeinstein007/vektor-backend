-- NW-021: custom model training as a product surface.
--
-- HAND-WRITTEN for the RLS policies' `current_setting()` predicate and the
-- partial unique index below.
--
-- Depends on 0011 for `organisations`.

CREATE TABLE IF NOT EXISTS "training_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	-- A URI, never the imagery itself. A customer's labelled training set is
	-- their most sensitive asset and the thing most likely to carry a
	-- retention agreement; copying it in here would make every database
	-- backup a copy of it.
	"dataset_uri" text NOT NULL,
	"base_model" text DEFAULT 'yolov8n.pt' NOT NULL,
	"epochs" integer DEFAULT 100 NOT NULL,
	"imgsz" integer DEFAULT 640 NOT NULL,
	"classes" text[] NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"started_at" timestamptz,
	"finished_at" timestamptz,
	"error" text,
	CONSTRAINT "training_jobs_state_check" CHECK ("state" IN
		('QUEUED','TRAINING','EXPORTING','SUCCEEDED','FAILED','CANCELLED'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "model_versions" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"artifact_uri" text NOT NULL,
	-- The only way to answer "is the model running at site 3 the one we
	-- think we shipped". A path says where it came from, not what it is.
	"artifact_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"classes" text[] NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms_p95" real,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"deployed_to" text[] DEFAULT '{}' NOT NULL,
	"retired_at" timestamptz
);
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'organisations') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_jobs_org_id_fk') THEN
      ALTER TABLE "training_jobs" ADD CONSTRAINT "training_jobs_org_id_fk"
        FOREIGN KEY ("org_id") REFERENCES "organisations"("org_id");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_versions_org_id_fk') THEN
      ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_org_id_fk"
        FOREIGN KEY ("org_id") REFERENCES "organisations"("org_id");
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'model_versions_job_id_fk') THEN
    ALTER TABLE "model_versions" ADD CONSTRAINT "model_versions_job_id_fk"
      FOREIGN KEY ("job_id") REFERENCES "training_jobs"("job_id");
  END IF;
END
$$;--> statement-breakpoint

-- Version numbers are per organisation, so two customers both have a
-- "version 3" and neither has to explain why theirs starts at 47. UNIQUE
-- rather than a sequence because a sequence is global and would leak how
-- many models every other customer has trained.
CREATE UNIQUE INDEX IF NOT EXISTS "model_versions_org_version_uniq"
  ON "model_versions" ("org_id", "version");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "training_jobs_org_state_idx" ON "training_jobs" ("org_id", "state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_versions_org_idx" ON "model_versions" ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_versions_job_idx" ON "model_versions" ("job_id");--> statement-breakpoint

ALTER TABLE "training_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "training_jobs_org_isolation" ON "training_jobs";--> statement-breakpoint
CREATE POLICY "training_jobs_org_isolation" ON "training_jobs" AS PERMISSIVE FOR ALL TO "vektor_app"
  USING (org_id = current_setting('vektor.org_id')::uuid)
  WITH CHECK (org_id = current_setting('vektor.org_id')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "training_jobs" TO "vektor_app";--> statement-breakpoint

ALTER TABLE "model_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "model_versions_org_isolation" ON "model_versions";--> statement-breakpoint
CREATE POLICY "model_versions_org_isolation" ON "model_versions" AS PERMISSIVE FOR ALL TO "vektor_app"
  USING (org_id = current_setting('vektor.org_id')::uuid)
  WITH CHECK (org_id = current_setting('vektor.org_id')::uuid);--> statement-breakpoint
-- No DELETE on either: retirement is a timestamp. A model that was running
-- when an incident happened is evidence, and a deleted row cannot be
-- produced in an after-action review.
GRANT SELECT, INSERT, UPDATE ON "model_versions" TO "vektor_app";
