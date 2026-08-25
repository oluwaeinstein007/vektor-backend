// packages/db/src/schema/reporting.ts — Phase 5, SVC-020. Storage layer for
// @vektor/proto's Report/ReportSchedule. `file_path` is a path on
// reporting-svc's local disk (storage/ — see reporting-svc/README.md), not
// bytea in Postgres: a generated PDF/PPTX has no reason to round-trip
// through the database itself, only its metadata does.
import { pgTable, uuid, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";

export const reports = pgTable("reports", {
  report_id: uuid("report_id").primaryKey().defaultRandom(),
  format: text("format").notNull(), // PDF | PPTX
  status: text("status").notNull().default("PENDING"),
  file_path: text("file_path"),
  schedule_id: uuid("schedule_id"),
  requested_at: timestamp("requested_at").defaultNow(),
  completed_at: timestamp("completed_at"),
});

export const reportSchedules = pgTable("report_schedules", {
  schedule_id: uuid("schedule_id").primaryKey().defaultRandom(),
  cron_expr: text("cron_expr").notNull(),
  format: text("format").notNull(),
  recipients: jsonb("recipients").notNull(), // string[]
  active: boolean("active").notNull().default(true),
  last_run_at: timestamp("last_run_at"),
});
