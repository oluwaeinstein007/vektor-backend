CREATE TABLE "entities" (
	"entity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"classification" text NOT NULL,
	"confidence" real NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"affiliation" text DEFAULT 'UNKNOWN' NOT NULL,
	"position" geometry(point),
	"kinematics" jsonb,
	"metadata" jsonb,
	"first_detected" timestamp DEFAULT now(),
	"last_updated" timestamp DEFAULT now()
);
