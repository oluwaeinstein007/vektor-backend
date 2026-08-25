import { eq } from "drizzle-orm";
import { reports, type VektorDb } from "@vektor/db";
import type { ReportFormat } from "@vektor/shared";

export type ReportRow = typeof reports.$inferSelect;

export async function createPendingReport(db: VektorDb, format: ReportFormat, scheduleId: string | null = null): Promise<ReportRow> {
  const [row] = await db.insert(reports).values({ format, status: "PENDING", schedule_id: scheduleId }).returning();
  return row!;
}

export async function markReportComplete(db: VektorDb, reportId: string, filePath: string): Promise<void> {
  await db.update(reports).set({ status: "COMPLETE", file_path: filePath, completed_at: new Date() }).where(eq(reports.report_id, reportId));
}

export async function markReportFailed(db: VektorDb, reportId: string): Promise<void> {
  await db.update(reports).set({ status: "FAILED", completed_at: new Date() }).where(eq(reports.report_id, reportId));
}

export async function getReport(db: VektorDb, reportId: string): Promise<ReportRow | null> {
  const rows = await db.select().from(reports).where(eq(reports.report_id, reportId)).limit(1);
  return rows[0] ?? null;
}
