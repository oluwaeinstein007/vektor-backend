import { eq, desc } from "drizzle-orm";
import { coas, type VektorDb } from "@vektor/db";
import type { COAOption } from "@vektor/shared";

export async function insertCoa(
  db: VektorDb,
  params: { situation_id: string; options: COAOption[] },
): Promise<typeof coas.$inferSelect> {
  const [row] = await db
    .insert(coas)
    .values({ situation_id: params.situation_id, options: params.options })
    .returning();
  if (!row) throw new Error("insertCoa: insert returned no row");
  return row;
}

export async function listCoasBySituation(db: VektorDb, situationId: string) {
  return db.query.coas.findMany({
    where: eq(coas.situation_id, situationId),
    orderBy: desc(coas.generated_at),
  });
}

export async function getCoaById(db: VektorDb, coaId: string) {
  return db.query.coas.findFirst({ where: eq(coas.coa_id, coaId) });
}

export async function decideCoa(
  db: VektorDb,
  params: { coa_id: string; decision: "APPROVED" | "REJECTED"; selected_option: number | null; notes: string | null },
): Promise<typeof coas.$inferSelect | undefined> {
  const [row] = await db
    .update(coas)
    .set({ status: params.decision, selected_option: params.selected_option, commander_notes: params.notes, updated_at: new Date() })
    .where(eq(coas.coa_id, params.coa_id))
    .returning();
  return row;
}
