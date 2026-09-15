CREATE TABLE "sensor_registry" (
	"sensor_id" text PRIMARY KEY NOT NULL,
	"sensor_type" text NOT NULL,
	"label" text NOT NULL,
	"position" geometry(point) NOT NULL,
	"coverage_radius_m" real NOT NULL,
	"registered_at" timestamp DEFAULT now()
);
