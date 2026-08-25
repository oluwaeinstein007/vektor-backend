// Real headless Chrome (system google-chrome via puppeteer-core, same
// pattern apps/web's Playwright verification already established) and real
// pptxgenjs slide generation — both produce actual binary files, not
// hand-waved "should work" stubs. Verified by checking real file-format
// magic bytes, not just "a Buffer with length > 0".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createDb } from "@vektor/db";
import { generateReport } from "../src/generate/orchestrator.js";
import { renderSituationReportHtml } from "../src/generate/htmlTemplate.js";
import { getReport } from "../src/db/reports.js";
import { createPendingReport } from "../src/db/reports.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("renderSituationReportHtml: escapes attacker-controlled alert message content", () => {
  const html = renderSituationReportHtml({
    generated_at: new Date().toISOString(),
    entity_counts_by_affiliation: { HOSTILE: 2 },
    total_entities: 2,
    open_alerts: [{ alert_id: randomUUID(), type: "ANOMALY", severity: "HIGH", message: "<script>alert(1)</script>" }],
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("generateReport: PDF format produces a real PDF file (magic bytes + non-trivial size)", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());
  const dir = await mkdtemp(join(tmpdir(), "vektor-reports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report = await createPendingReport(db, "PDF");
  const filePath = await generateReport(db, report.report_id, "PDF", dir);

  const buffer = await readFile(filePath);
  assert.ok(buffer.length > 1000, `PDF should be a real non-trivial file, got ${buffer.length} bytes`);
  assert.equal(buffer.subarray(0, 5).toString("ascii"), "%PDF-");

  const updated = await getReport(db, report.report_id);
  assert.equal(updated?.status, "COMPLETE");
  assert.equal(updated?.file_path, filePath);
});

test("generateReport: PPTX format produces a real .pptx (a valid ZIP/OOXML container)", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());
  const dir = await mkdtemp(join(tmpdir(), "vektor-reports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report = await createPendingReport(db, "PPTX");
  const filePath = await generateReport(db, report.report_id, "PPTX", dir);

  const buffer = await readFile(filePath);
  assert.ok(buffer.length > 1000, `PPTX should be a real non-trivial file, got ${buffer.length} bytes`);
  // PPTX is a ZIP container — "PK\x03\x04" is the ZIP local-file-header magic.
  assert.equal(buffer.subarray(0, 4).toString("hex"), "504b0304");

  const updated = await getReport(db, report.report_id);
  assert.equal(updated?.status, "COMPLETE");
});
