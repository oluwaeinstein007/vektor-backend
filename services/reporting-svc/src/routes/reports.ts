// SVC-020 REST surface — 07-data-api.md §13.1: GET /api/v1/reports/:id.
// POST isn't in the PRD's endpoint table (that table only lists the
// retrieval route), but a sitrep has to be *requested* somehow — same
// "no PRD spec, follow the existing route pattern" note as fusion-svc's
// blueforce/routes.ts and logistics-svc's road-edge block route.
import { readFile } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ReportFormat, Report } from "@vektor/shared";
import { createPendingReport, getReport } from "../db/reports.js";
import { generateReport } from "../generate/orchestrator.js";

const ErrorResponse = z.object({ error: z.string() });
const ReportIdParams = z.object({ id: z.string().uuid() });
const CreateReportBody = z.object({ format: ReportFormat });

function toWireReport(row: { report_id: string; format: string; status: string; requested_at: Date | null; completed_at: Date | null }): Report {
  return Report.parse({
    report_id: row.report_id,
    format: row.format,
    status: row.status,
    requested_at: (row.requested_at ?? new Date()).toISOString(),
    completed_at: row.completed_at ? row.completed_at.toISOString() : null,
  });
}

export default function buildReportRoutes(storageDir: string): FastifyPluginAsync {
  return async (app) => {
    const typedApp = app.withTypeProvider<ZodTypeProvider>();

    // REQ-7.1: "within 30s" — this synchronously awaits generation rather
    // than returning PENDING immediately, since 30s is well within a single
    // HTTP request's reasonable timeout and it keeps the client-facing
    // contract simple (no separate poll loop needed for the common case).
    typedApp.post(
      "/api/v1/reports",
      { schema: { body: CreateReportBody, response: { 200: Report } } },
      async (request) => {
        const report = await createPendingReport(app.db, request.body.format);
        await generateReport(app.db, report.report_id, request.body.format, storageDir);
        const updated = await getReport(app.db, report.report_id);
        return toWireReport(updated!);
      },
    );

    // Deliberately NOT typedApp: this route's 200 response is either a JSON
    // Report (still-pending/failed) or a raw PDF/PPTX Buffer depending on
    // status — no single zod schema covers both, and declaring one here
    // would make fastify-type-provider-zod reject reply.send() for
    // whichever shape isn't declared. Only 404 gets a real schema; the
    // 200 cases fall back to Fastify's default (un-validated) serialization.
    app.get(
      "/api/v1/reports/:id",
      { schema: { params: ReportIdParams, response: { 404: ErrorResponse } } },
      async (request, reply) => {
        const report = await getReport(app.db, (request.params as { id: string }).id);
        if (!report) return reply.code(404).send({ error: "report not found" });
        if (report.status !== "COMPLETE" || !report.file_path) {
          return reply.send(toWireReport(report));
        }
        const buffer = await readFile(report.file_path);
        const contentType = report.format === "PDF" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        return reply.type(contentType).send(buffer);
      },
    );
  };
}
