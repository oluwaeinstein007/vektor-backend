ALTER TABLE "entities" ADD COLUMN "source_sensors" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "alt_m" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "accuracy_m" real DEFAULT 0 NOT NULL;