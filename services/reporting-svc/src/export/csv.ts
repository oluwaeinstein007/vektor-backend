import type { ExportRow } from "./query.js";

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(rows: ExportRow[]): string {
  const header = ["entity_id", "classification", "affiliation", "status", "lon", "lat", "alt_m", "last_updated"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.entity_id,
        csvEscape(r.classification),
        r.affiliation,
        r.status,
        r.lon ?? "",
        r.lat ?? "",
        r.alt_m,
        r.last_updated.toISOString(),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
