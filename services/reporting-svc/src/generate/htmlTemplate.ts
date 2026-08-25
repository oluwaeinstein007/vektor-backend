import type { SituationSummary } from "./situationData.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain server-rendered HTML — no client JS, no external assets, since puppeteer-core just needs something to rasterize to PDF. */
export function renderSituationReportHtml(summary: SituationSummary): string {
  const affiliationRows = Object.entries(summary.entity_counts_by_affiliation)
    .map(([affiliation, count]) => `<tr><td>${escapeHtml(affiliation)}</td><td>${count}</td></tr>`)
    .join("");

  const alertRows = summary.open_alerts
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.severity)}</td><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.message)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; padding: 32px; color: #111; }
  h1 { font-size: 20px; }
  h2 { font-size: 15px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; margin-top: 8px; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; font-size: 12px; }
  th { background: #eee; }
</style>
</head>
<body>
  <h1>VEKTOR Situation Report</h1>
  <p>Generated: ${escapeHtml(summary.generated_at)}</p>
  <h2>Entities by Affiliation (${summary.total_entities} total)</h2>
  <table><thead><tr><th>Affiliation</th><th>Count</th></tr></thead><tbody>${affiliationRows}</tbody></table>
  <h2>Open Alerts (${summary.open_alerts.length})</h2>
  <table><thead><tr><th>Severity</th><th>Type</th><th>Message</th></tr></thead><tbody>${alertRows}</tbody></table>
</body>
</html>`;
}
