// Fusion pipeline's write path — the entities table stays the single
// durable output of correlation/EKF smoothing/ontology mapping, same table
// geospatial-svc's REST API reads from. changedFields drives the
// entity:new vs entity:updated Socket.io decision (socket/gateway.ts) and
// fills EntityUpdatedEvent.changed_fields (§13.2).
import type { InferSelectModel } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { entities, type VektorDb } from "@vektor/db";
import type { Entity } from "@vektor/shared";

type EntityRow = InferSelectModel<typeof entities>;

export interface UpsertResult {
  isNew: boolean;
  changedFields: string[];
}

export async function upsertEntity(db: VektorDb, entity: Entity): Promise<UpsertResult> {
  const existingRows = await db.select().from(entities).where(eq(entities.entity_id, entity.entity_id)).limit(1);
  const existing = existingRows[0];

  const values = {
    classification: entity.classification,
    confidence: entity.confidence,
    status: entity.status,
    affiliation: entity.affiliation,
    source_sensors: entity.source_sensors,
    position: [entity.position.lon, entity.position.lat] as [number, number],
    alt_m: entity.position.alt_m,
    accuracy_m: entity.position.accuracy_m,
    kinematics: entity.kinematics,
    metadata: entity.metadata,
    last_updated: new Date(entity.last_updated),
  };

  if (!existing) {
    await db.insert(entities).values({
      entity_id: entity.entity_id,
      ...values,
      first_detected: new Date(entity.first_detected),
    });
    return { isNew: true, changedFields: [] };
  }

  const changedFields = diffFields(existing, values);
  if (changedFields.length > 0) {
    await db.update(entities).set(values).where(eq(entities.entity_id, entity.entity_id));
  }
  return { isNew: false, changedFields };
}

interface NextEntityValues {
  classification: string;
  confidence: number;
  status: string;
  affiliation: string;
  source_sensors: string[];
  position: [number, number];
  alt_m: number;
  accuracy_m: number;
  kinematics: unknown;
  metadata: unknown;
}

function diffFields(row: EntityRow, next: NextEntityValues): string[] {
  const changed: string[] = [];
  if (row.classification !== next.classification) changed.push("classification");
  if (row.confidence !== next.confidence) changed.push("confidence");
  if (row.status !== next.status) changed.push("status");
  if (row.affiliation !== next.affiliation) changed.push("affiliation");
  if (JSON.stringify(row.source_sensors) !== JSON.stringify(next.source_sensors)) changed.push("source_sensors");

  const [oldLon, oldLat] = (row.position as [number, number] | null) ?? [0, 0];
  const [newLon, newLat] = next.position;
  if (oldLon !== newLon || oldLat !== newLat || row.alt_m !== next.alt_m || row.accuracy_m !== next.accuracy_m) {
    changed.push("position");
  }
  if (JSON.stringify(row.kinematics) !== JSON.stringify(next.kinematics)) changed.push("kinematics");
  if (JSON.stringify(row.metadata) !== JSON.stringify(next.metadata)) changed.push("metadata");
  return changed;
}
