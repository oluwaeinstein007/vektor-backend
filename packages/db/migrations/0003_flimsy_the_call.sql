CREATE TABLE "coas" (
	"coa_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"situation_id" uuid NOT NULL,
	"options" jsonb NOT NULL,
	"selected_option" integer,
	"commander_notes" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"generated_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"audit_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp DEFAULT now()
);
