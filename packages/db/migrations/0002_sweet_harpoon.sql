CREATE TABLE "blue_force_assets" (
	"asset_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"callsign" text NOT NULL,
	"classification" text NOT NULL,
	"position" geometry(point) NOT NULL,
	"alt_m" real DEFAULT 0 NOT NULL,
	"buffer_radius_m" real NOT NULL,
	"last_updated" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "no_strike_zones" (
	"zone_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"source_asset_id" uuid,
	"geom" geometry(polygon) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
