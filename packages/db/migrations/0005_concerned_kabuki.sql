CREATE TABLE "inventory_forecasts" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"quantity" real NOT NULL,
	"depletion_rate_per_hour" real NOT NULL,
	"hours_to_stockout" real,
	"low_stock" boolean DEFAULT false NOT NULL,
	"forecast_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "inventory_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" real NOT NULL,
	"ts" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"quantity" real NOT NULL,
	"reorder_threshold" real NOT NULL,
	"location" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
