CREATE TABLE "alert_actions" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"action" text NOT NULL,
	"operator_id" text NOT NULL,
	"ts" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"alert_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"entity_id" uuid,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"dispatch_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ts" timestamp DEFAULT now(),
	"acknowledged_by" text,
	"acknowledged_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "geofence_zones" (
	"zone_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"trigger" text NOT NULL,
	"severity" text NOT NULL,
	"affiliation_filter" text,
	"channels" jsonb NOT NULL,
	"notify" jsonb NOT NULL,
	"geom" geometry(polygon) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now()
);
