// Read-only queries against tables coa-svc doesn't own — `entities` and
// `blue_force_assets` are written by fusion-svc, but coa-svc reads them
// directly via the same shared Postgres instance rather than proxying
// through fusion-svc/geospatial-svc's REST APIs. This mirrors the existing
// precedent in this codebase: geospatial-svc and fusion-svc both already
// read/write these exact tables directly via Drizzle, so a third TS
// service doing typed reads against them isn't a new pattern. (no-strike
// zones are the one exception — see context/fetchNoStrikeZones.ts — their
// polygon geometry needs fusion-svc's raw-SQL ST_AsGeoJSON extraction,
// which isn't worth forking here.)
import { eq } from "drizzle-orm";
import { entities, blueForceAssets, type VektorDb } from "@vektor/db";

export async function listActiveEntities(db: VektorDb) {
  return db.query.entities.findMany({ where: eq(entities.status, "ACTIVE") });
}

export async function getEntityById(db: VektorDb, entityId: string) {
  return db.query.entities.findFirst({ where: eq(entities.entity_id, entityId) });
}

export async function listBlueForceAssets(db: VektorDb) {
  return db.query.blueForceAssets.findMany();
}
