// SVC-020 — REQ-7.1: "Report generated within 30s of request." The route
// handler (routes/reports.ts) creates the PENDING row and returns
// immediately with report_id; this function does the actual (potentially
// slow, real-headless-Chrome) generation work and is awaited directly by
// tests, same request/poll split as coa-svc's async COA generation.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VektorDb } from "@vektor/db";
import type { ReportFormat } from "@vektor/shared";
import { gatherSituationSummary } from "./situationData.js";
import { renderSituationReportHtml } from "./htmlTemplate.js";
import { renderHtmlToPdf } from "./pdf.js";
import { renderSituationReportPptx } from "./pptx.js";
import { markReportComplete, markReportFailed } from "../db/reports.js";

export async function generateReport(db: VektorDb, reportId: string, format: ReportFormat, storageDir: string): Promise<string> {
  try {
    const summary = await gatherSituationSummary(db);
    let buffer: Buffer;
    let extension: string;

    if (format === "PDF") {
      const html = renderSituationReportHtml(summary);
      buffer = await renderHtmlToPdf(html);
      extension = "pdf";
    } else {
      buffer = await renderSituationReportPptx(summary);
      extension = "pptx";
    }

    await mkdir(storageDir, { recursive: true });
    const filePath = join(storageDir, `${reportId}.${extension}`);
    await writeFile(filePath, buffer);

    await markReportComplete(db, reportId, filePath);
    return filePath;
  } catch (err) {
    await markReportFailed(db, reportId);
    throw err;
  }
}
