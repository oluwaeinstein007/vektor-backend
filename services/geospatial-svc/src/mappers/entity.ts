// Maps a raw `entities` table row (@vektor/db) to the canonical wire
// `Entity` (PRD §7 Epic 3 / @vektor/proto). The DB row and the wire contract
// are deliberately not the same shape — see packages/db/src/schema/entities.ts
// for why position/kinematics/metadata need translation instead of a
// straight column-to-field copy. Routing every response through Entity.parse
// (not just `as Entity`) means a future column rename or type drift fails
// loudly here instead of silently shipping a contract-violating payload.
import type { InferSelectModel } from "drizzle-orm";
// mgrs ships as CommonJS (no ESM build) — under NodeNext resolution, Node's
// interop only gives us the default export, not a `forward` named export,
// even though the .d.ts declares one. Destructure off the default instead.
import mgrsPkg from "mgrs";
import { Entity } from "@vektor/shared";
import type { entities } from "@vektor/db";

const { forward: toMgrs } = mgrsPkg;

export type EntityRow = InferSelectModel<typeof entities>;

const DEFAULT_KINEMATICS = { speed_kmh: 0, heading_deg: 0, trajectory: [] };
const DEFAULT_METADATA = { tags: [], analyst_notes: "", no_strike: false };

export function toWireEntity(row: EntityRow): Entity {
  // drizzle-orm's PgGeometry column (default "tuple" mode) parses EWKB into
  // [x, y] === [lon, lat] — see PgGeometry.mapFromDriverValue in
  // drizzle-orm/pg-core/columns/postgis_extension. A row with no position
  // yet (not expected in practice — every write path sets it — but the
  // column is nullable) falls back to [0, 0] rather than throwing, since
  // mgrs.forward requires a real coordinate pair.
  const [lon, lat] = row.position ?? [0, 0];

  return Entity.parse({
    entity_id: row.entity_id,
    classification: row.classification,
    confidence: row.confidence,
    status: row.status,
    affiliation: row.affiliation,
    source_sensors: row.source_sensors,
    position: {
      lat,
      lon,
      alt_m: row.alt_m,
      mgrs: toMgrs([lon, lat]),
      accuracy_m: row.accuracy_m,
    },
    // Merge rather than replace-if-null: jsonb columns can hold a *partial*
    // object when a write path patches just one field (e.g. tagEntity's
    // `{ tags }` update in queries/entities.ts) — a raw `?? DEFAULT` would
    // pass that partial straight to Entity.parse and fail validation on the
    // fields the patch didn't touch.
    kinematics: { ...DEFAULT_KINEMATICS, ...(row.kinematics as Partial<typeof DEFAULT_KINEMATICS> | null) },
    metadata: { ...DEFAULT_METADATA, ...(row.metadata as Partial<typeof DEFAULT_METADATA> | null) },
    first_detected: row.first_detected?.toISOString(),
    last_updated: row.last_updated?.toISOString(),
  });
}
