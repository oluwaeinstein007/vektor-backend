// SVC-020 — REQ-7.1's report content: a snapshot of active entities +
// open alerts at generation time. No ontology mapping needed here (unlike
// fusion-svc's Entity mapper) — a sitrep only needs aggregate counts and a
// short table, not the full canonical Entity shape.
import { desc, eq, ne } from "drizzle-orm";
import { entities, alerts, type VektorDb } from "@vektor/db";

export interface SituationSummary {
  generated_at: string;
  entity_counts_by_affiliation: Record<string, number>;
  total_entities: number;
  open_alerts: Array<{ alert_id: string; type: string; severity: string; message: string }>;
}

export async function gatherSituationSummary(db: VektorDb): Promise<SituationSummary> {
  const activeEntities = await db.select().from(entities).where(ne(entities.status, "ARCHIVED"));

  const counts: Record<string, number> = {};
  for (const e of activeEntities) {
    counts[e.affiliation] = (counts[e.affiliation] ?? 0) + 1;
  }

  const openAlerts = await db.select().from(alerts).where(eq(alerts.status, "OPEN")).orderBy(desc(alerts.ts)).limit(50);

  return {
    generated_at: new Date().toISOString(),
    entity_counts_by_affiliation: counts,
    total_entities: activeEntities.length,
    open_alerts: openAlerts.map((a) => ({ alert_id: a.alert_id, type: a.type, severity: a.severity, message: a.message })),
  };
}
