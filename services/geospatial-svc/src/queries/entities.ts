// SVC-005: PostGIS CRUD + spatial query API — backs GET/POST /api/v1/entities
// (§13.1). Drizzle query functions only; no HTTP concerns here, so they're
// unit-testable against a real Postgres independent of Fastify.
import { and, eq, sql } from "drizzle-orm";
import { entities, type VektorDb } from "@vektor/db";
import type { BoundingBox } from "@vektor/shared";

export interface ListEntitiesFilter {
  classification?: string;
  affiliation?: string;
  bbox?: BoundingBox;
  limit: number;
  offset: number;
}

export async function listEntities(db: VektorDb, filter: ListEntitiesFilter) {
  const conditions = [eq(entities.status, "ACTIVE")];

  if (filter.classification) {
    conditions.push(eq(entities.classification, filter.classification));
  }
  if (filter.affiliation) {
    conditions.push(eq(entities.affiliation, filter.affiliation));
  }
  if (filter.bbox) {
    const { min_lon, min_lat, max_lon, max_lat } = filter.bbox;
    // ST_MakeEnvelope(xmin, ymin, xmax, ymax, srid) — PostGIS wants
    // lon/lat order (x/y), not lat/lon, which is why this isn't a plain
    // Drizzle column comparison.
    conditions.push(
      sql`ST_Contains(ST_MakeEnvelope(${min_lon}, ${min_lat}, ${max_lon}, ${max_lat}, 4326), ${entities.position})`,
    );
  }

  return db
    .select()
    .from(entities)
    .where(and(...conditions))
    .limit(filter.limit)
    .offset(filter.offset);
}

export async function getEntity(db: VektorDb, entityId: string) {
  const rows = await db.select().from(entities).where(eq(entities.entity_id, entityId)).limit(1);
  return rows[0] ?? null;
}

export async function tagEntity(db: VektorDb, entityId: string, tag: string) {
  const existing = await getEntity(db, entityId);
  if (!existing) return null;

  const metadata = (existing.metadata ?? {}) as { tags?: string[] };
  const tags = Array.from(new Set([...(metadata.tags ?? []), tag]));

  const [updated] = await db
    .update(entities)
    .set({
      metadata: { ...metadata, tags },
      last_updated: new Date(),
    })
    .where(eq(entities.entity_id, entityId))
    .returning();

  return updated ?? null;
}
