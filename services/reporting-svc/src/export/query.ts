// SVC-020 — REQ-7.3: "Raw data export (CSV, GeoJSON) ... 30-day, single-AOI
// query within 60s." Same bbox/SRID pattern as geospatial-svc's
// queries/entities.ts (entities.position carries no SRID label — see
// vektor-build-conventions memory) — duplicated here rather than imported
// since geospatial-svc's query module isn't a shared package, same
// boundary every other cross-service query in this repo respects.
import { and, gte, lte, sql } from "drizzle-orm";
import { entities, type VektorDb } from "@vektor/db";

export interface ExportFilter {
  from: Date;
  to: Date;
  bbox?: { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
}

export interface ExportRow {
  entity_id: string;
  classification: string;
  affiliation: string;
  status: string;
  lon: number | null;
  lat: number | null;
  alt_m: number;
  last_updated: Date;
}

export async function queryEntitiesForExport(db: VektorDb, filter: ExportFilter): Promise<ExportRow[]> {
  const conditions = [gte(entities.last_updated, filter.from), lte(entities.last_updated, filter.to)];

  if (filter.bbox) {
    const { min_lon, min_lat, max_lon, max_lat } = filter.bbox;
    conditions.push(
      sql`ST_Contains(ST_MakeEnvelope(${min_lon}, ${min_lat}, ${max_lon}, ${max_lat}, 4326), ST_SetSRID(${entities.position}, 4326))`,
    );
  }

  // A raw db.execute(sql`...`) mapper gets a timestamp column back as a
  // string, not a Date — only Drizzle's typed select() path auto-converts
  // (see vektor-build-conventions memory; fusion-svc's no-strike-zone
  // mapper hit the identical thing). Convert explicitly rather than typing
  // this as Date and having toCsv/toGeoJson's .toISOString() calls throw.
  const rows = await db.execute<{
    entity_id: string;
    classification: string;
    affiliation: string;
    status: string;
    lon: number | null;
    lat: number | null;
    alt_m: number;
    last_updated: string;
  }>(sql`
    SELECT entity_id, classification, affiliation, status,
      ST_X(position) AS lon, ST_Y(position) AS lat, alt_m, last_updated
    FROM entities
    WHERE ${and(...conditions)}
  `);
  return rows.map((r) => ({ ...r, last_updated: new Date(r.last_updated) })) as unknown as ExportRow[];
}
