CREATE TABLE "report_schedules" (
	"schedule_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cron_expr" text NOT NULL,
	"format" text NOT NULL,
	"recipients" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"file_path" text,
	"schedule_id" uuid,
	"requested_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
