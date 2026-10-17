// NW-018: the history projector — a Kafka consumer that turns the durable
// `{env}.vektor.entities.upserted` topic into rows in `entity_history`.
//
// A consumer rather than a write-through on fusion-svc's upsert path, for
// two reasons that both matter:
//   1. It can rebuild the entire history from a topic that already exists.
//      A write-through path can only ever record what happens after it is
//      deployed, so the Phase 6 durable topic's existing contents would be
//      unreachable forever.
//   2. It keeps the history write off the real-time sensor→operator leg,
//      which is already the latency-sensitive part of the system.
//
// Idempotent by construction: ON CONFLICT (entity_id, ts) DO NOTHING against
// the unique constraint migration 0009 defines, so a consumer-group reset,
// a redelivery after a crash, or a deliberate backfill all converge on the
// same rows instead of doubling every track.
import { sql } from "drizzle-orm";
import type { Consumer, EachMessagePayload, Kafka } from "kafkajs";
import type { VektorDb } from "@vektor/db";
import { Entity } from "@vektor/shared";

export interface HistoryProjectorOptions {
  kafka: Kafka;
  db: VektorDb;
  topic: string;
  groupId: string;
  /** Called per persisted observation; wired to the service logger. */
  onProjected?: (entityId: string, ts: string) => void;
  onSkipped?: (reason: string, detail?: unknown) => void;
}

export interface HistoryProjector {
  stop: () => Promise<void>;
}

/**
 * Days whose partition this process has already ensured. Partition creation
 * is one round-trip per new day rather than per row — without this cache,
 * every insert would carry a redundant `SELECT ensure_...` and the projector
 * would do twice the database work for no benefit.
 *
 * Process-local on purpose: it is a cache of a fact that only ever becomes
 * more true (a partition, once created, is not removed except by retention,
 * which runs against days nothing is still writing to).
 */
const ensuredDays = new Set<string>();

function dayKey(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

export async function ensurePartitionFor(db: VektorDb, ts: Date): Promise<void> {
  const key = dayKey(ts);
  if (ensuredDays.has(key)) return;
  await db.execute(sql`SELECT ensure_entity_history_partition(${key}::date)`);
  ensuredDays.add(key);
}

/** Exported for tests — lets a suite start from a known-cold cache. */
export function resetEnsuredDaysCache(): void {
  ensuredDays.clear();
}

export async function recordObservation(db: VektorDb, entity: Entity, observedAt: Date): Promise<void> {
  await ensurePartitionFor(db, observedAt);
  await db.execute(sql`
    INSERT INTO entity_history
      (entity_id, ts, position, alt_m, speed_kmh, heading_deg, confidence,
       classification, affiliation, status)
    VALUES (
      ${entity.entity_id}::uuid,
      ${observedAt.toISOString()}::timestamptz,
      ST_SetSRID(ST_MakePoint(${entity.position.lon}, ${entity.position.lat}), 4326),
      ${entity.position.alt_m},
      ${entity.kinematics.speed_kmh},
      ${entity.kinematics.heading_deg},
      ${entity.confidence},
      ${entity.classification},
      ${entity.affiliation},
      ${entity.status}
    )
    ON CONFLICT (entity_id, ts) DO NOTHING
  `);
}

export async function startHistoryProjector(options: HistoryProjectorOptions): Promise<HistoryProjector> {
  const consumer: Consumer = options.kafka.consumer({ groupId: options.groupId });
  await consumer.connect();
  // fromBeginning: the point of projecting from a durable topic is to pick
  // up what is already in it. A new deployment with retained history should
  // backfill, not start empty.
  await consumer.subscribe({ topic: options.topic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }: EachMessagePayload) => {
      if (!message.value) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(message.value.toString());
      } catch (error) {
        // A malformed message must not stall the partition forever. Log and
        // move on — the offset commits and the topic keeps flowing.
        options.onSkipped?.("unparseable JSON", error);
        return;
      }

      const envelope = parsed as { entity?: unknown; entity_id?: string; ts?: string };

      // entity === null marks the entity lost/evicted (see fusion-svc's
      // entityProducer). There is no position to record, and writing a
      // tombstone row would put a point at [0,0] in the middle of a track.
      if (envelope.entity === null || envelope.entity === undefined) return;

      const result = Entity.safeParse(envelope.entity);
      if (!result.success) {
        options.onSkipped?.("entity failed schema validation", result.error.issues);
        return;
      }
      const entity = result.data;

      // Observation time from the entity's own last_updated, NOT from the
      // envelope ts or from now(): a replayed or backfilled topic must
      // produce the same history as a live one, and a write-time stamp
      // would collapse every backfilled observation into the instant the
      // backfill ran.
      const observedAt = new Date(entity.last_updated);
      if (Number.isNaN(observedAt.getTime())) {
        options.onSkipped?.("entity has an unparseable last_updated", entity.last_updated);
        return;
      }

      // Deliberately NOT caught: a failed write must not commit its offset.
      // kafkajs will redeliver, which is the correct behaviour for a
      // transient database problem and makes a genuine bug loud instead of
      // silently dropping history.
      await recordObservation(options.db, entity, observedAt);
      options.onProjected?.(entity.entity_id, observedAt.toISOString());
    },
  });

  return {
    stop: async () => {
      await consumer.disconnect();
    },
  };
}

/**
 * Retention. Called on an interval by index.ts; drops whole day partitions
 * older than the window, which is near-instant and returns the disk
 * immediately, unlike the DELETE it replaces.
 */
export async function applyRetention(db: VektorDb, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await db.execute(
    sql`SELECT drop_entity_history_partitions_before(${dayKey(cutoff)}::date) AS dropped`,
  );
  const first = (rows as unknown as Array<Record<string, unknown>>)[0];
  return Number(first?.dropped ?? 0);
}
