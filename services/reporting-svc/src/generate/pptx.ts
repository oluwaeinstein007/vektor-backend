// SVC-020 — REQ-7.1 PPTX half. pptxgenjs is CJS-only with no "exports"
// field (package.json: main=dist/pptxgen.cjs.js, no `module`/`exports`
// pointing at ESM) — under this repo's NodeNext + "type":"module" config,
// `import PptxGenJS from "pptxgenjs"` type-checks as the whole module
// namespace rather than the default-exported class ("has no construct
// signatures"), same CJS-interop category as the mgrs/ioredis pitfalls
// already documented for this project. Its own .d.ts makes this worse than
// the usual fix: it declares `export as namespace PptxGenJS` alongside
// `export default PptxGenJS`, so even a type-only default import resolves
// to the namespace ("Cannot use namespace as a type") — there's no clean
// way to import its real type. Fix: createRequire for the runtime value
// (a genuine CJS require, bypassing Node's ESM/CJS interop guessing
// entirely) plus a narrow local structural type for only the handful of
// methods this file actually calls, instead of fighting the package's type.
import { createRequire } from "node:module";
import type { SituationSummary } from "./situationData.js";

interface PptxSlide {
  addText(text: string, options: Record<string, unknown>): void;
  addTable(rows: string[][], options: Record<string, unknown>): void;
}
interface PptxPresentation {
  addSlide(): PptxSlide;
  write(options: { outputType: "nodebuffer" }): Promise<Buffer>;
}

const require = createRequire(import.meta.url);
const PptxGenJS = require("pptxgenjs") as new () => PptxPresentation;

export async function renderSituationReportPptx(summary: SituationSummary): Promise<Buffer> {
  const pres = new PptxGenJS();

  const title = pres.addSlide();
  title.addText("VEKTOR Situation Report", { x: 0.5, y: 1.5, w: 9, h: 1, fontSize: 28, bold: true });
  title.addText(`Generated: ${summary.generated_at}`, { x: 0.5, y: 2.5, w: 9, h: 0.5, fontSize: 14 });

  const affiliationSlide = pres.addSlide();
  affiliationSlide.addText(`Entities by Affiliation (${summary.total_entities} total)`, {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.6,
    fontSize: 20,
    bold: true,
  });
  const affiliationRows: string[][] = [
    ["Affiliation", "Count"],
    ...Object.entries(summary.entity_counts_by_affiliation).map(([k, v]) => [k, String(v)]),
  ];
  affiliationSlide.addTable(affiliationRows, { x: 0.5, y: 1.1, w: 9, fontSize: 12 });

  const alertsSlide = pres.addSlide();
  alertsSlide.addText(`Open Alerts (${summary.open_alerts.length})`, {
    x: 0.5,
    y: 0.3,
    w: 9,
    h: 0.6,
    fontSize: 20,
    bold: true,
  });
  const alertRows: string[][] = [
    ["Severity", "Type", "Message"],
    ...summary.open_alerts.map((a) => [a.severity, a.type, a.message]),
  ];
  alertsSlide.addTable(alertRows, { x: 0.5, y: 1.1, w: 9, fontSize: 10 });

  return pres.write({ outputType: "nodebuffer" });
}
