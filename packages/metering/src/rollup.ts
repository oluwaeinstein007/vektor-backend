// packages/metering/src/rollup.ts — NW-016.
//
// Folds usage events into per-(organisation, metric, hour) totals.
//
// The whole design problem here is idempotency. The natural rollup —
// `quantity = quantity + excluded.quantity` — is not idempotent, and Kafka
// is at-least-once: a consumer that crashes between writing the rollup and
// committing its offset replays the batch and counts it twice. For a
// latency metric that is noise. For a number on an invoice it is the defect
// that makes a customer stop trusting every other number you show them.
//
// So the consumer keeps its own offset in Postgres, written in the SAME
// transaction as the increment, and skips anything at or below it. Kafka's
// commit becomes a performance hint rather than the source of truth.
import { sql } from "drizzle-orm";
import type { VektorDb } from "@vektor/db";
import { usageEventSchema, type UsageEvent } from "./metrics.js";

/** A Kafka message reduced to what the fold needs. */
export interface RawUsageMessage {
  topic: string;
  partition: number;
  offset: string;
  value: string | null;
}

export interface FoldResult {
  applied: number;
  /** Already folded in a previous run — replay, correctly ignored. */
  skippedReplay: number;
  /** Failed schema validation. Counted, not thrown. */
  rejected: number;
}

/** Truncates to the start of the containing UTC hour. */
export function periodStart(at: Date): Date {
  const d = new Date(at.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Applies a batch atomically.
 *
 * Everything — the per-key increments and every partition's new offset —
 * happens in one transaction. A partial application would leave the offset
 * ahead of the rollups it claims to account for, and the difference would
 * be silently unbillable.
 */
export async function foldUsageBatch(db: VektorDb, messages: readonly RawUsageMessage[]): Promise<FoldResult> {
  const result: FoldResult = { applied: 0, skippedReplay: 0, rejected: 0 };
  if (messages.length === 0) return result;

  await db.transaction(async (tx) => {
    // Current progress per partition, locked for the duration so two
    // consumer instances cannot interleave and both decide a message is new.
    const partitions = [...new Set(messages.map((m) => `${m.topic}\u0000${m.partition}`))];
    const known = new Map<string, bigint>();
    for (const p of partitions) {
      const [topic, partitionStr] = p.split("\u0000");
      const rows = (await tx.execute(sql`
        SELECT last_offset FROM usage_consumer_offsets
        WHERE topic = ${topic} AND partition = ${Number(partitionStr)}
        FOR UPDATE
      `)) as unknown as { last_offset: string | bigint }[];
      if (rows[0]) known.set(p, BigInt(rows[0].last_offset));
    }

    // (org, metric, period) -> total, so a batch touching the same hour
    // repeatedly is one UPDATE rather than one per message.
    const totals = new Map<string, { event: UsageEvent; period: Date; quantity: bigint }>();
    const highest = new Map<string, bigint>();

    for (const message of messages) {
      const key = `${message.topic}\u0000${message.partition}`;
      const offset = BigInt(message.offset);
      const seen = known.get(key);
      if (seen !== undefined && offset <= seen) {
        result.skippedReplay += 1;
        continue;
      }
      const prevHigh = highest.get(key);
      if (prevHigh === undefined || offset > prevHigh) highest.set(key, offset);

      if (message.value === null) {
        result.rejected += 1;
        continue;
      }
      let event: UsageEvent;
      try {
        event = usageEventSchema.parse(JSON.parse(message.value));
      } catch {
        // A malformed usage event must not stall the consumer: it would
        // block every subsequent partition offset behind one bad message
        // and silently stop all billing. Counted and dropped.
        result.rejected += 1;
        continue;
      }

      const period = periodStart(new Date(event.occurred_at));
      const bucket = `${event.org_id}\u0000${event.metric}\u0000${period.toISOString()}`;
      const existing = totals.get(bucket);
      if (existing) existing.quantity += BigInt(event.quantity);
      else totals.set(bucket, { event, period, quantity: BigInt(event.quantity) });
      result.applied += 1;
    }

    for (const { event, period, quantity } of totals.values()) {
      await tx.execute(sql`
        INSERT INTO usage_rollups (org_id, metric, period_start, quantity, updated_at)
        VALUES (${event.org_id}::uuid, ${event.metric}, ${period.toISOString()}::timestamptz, ${quantity.toString()}::bigint, now())
        ON CONFLICT (org_id, metric, period_start)
        DO UPDATE SET quantity = usage_rollups.quantity + EXCLUDED.quantity, updated_at = now()
      `);
    }

    // Offsets advance even for batches that were entirely rejected —
    // otherwise a poison message is reprocessed and re-rejected forever.
    for (const [key, offset] of highest) {
      const [topic, partitionStr] = key.split("\u0000");
      await tx.execute(sql`
        INSERT INTO usage_consumer_offsets (topic, partition, last_offset, updated_at)
        VALUES (${topic}, ${Number(partitionStr)}, ${offset.toString()}::bigint, now())
        ON CONFLICT (topic, partition)
        DO UPDATE SET last_offset = EXCLUDED.last_offset, updated_at = now()
      `);
    }
  });

  return result;
}

export interface UsageTotal {
  metric: string;
  quantity: bigint;
}

/**
 * Billable totals for one organisation over a half-open window
 * [from, to). Half-open so consecutive periods neither overlap nor gap —
 * an inclusive upper bound double-counts the boundary hour on monthly
 * invoices, which is exactly the kind of error that shows up as a customer
 * noticing their January and February bills share an hour.
 */
export async function usageForPeriod(db: VektorDb, orgId: string, from: Date, to: Date): Promise<UsageTotal[]> {
  const rows = (await db.execute(sql`
    SELECT metric, SUM(quantity)::bigint AS quantity
    FROM usage_rollups
    WHERE org_id = ${orgId}::uuid
      AND period_start >= ${from.toISOString()}::timestamptz
      AND period_start <  ${to.toISOString()}::timestamptz
    GROUP BY metric
    ORDER BY metric
  `)) as unknown as { metric: string; quantity: string | bigint }[];
  return rows.map((r) => ({ metric: r.metric, quantity: BigInt(r.quantity) }));
}
