// packages/metering/src/emitter.ts — NW-016.
//
// The rule this file exists to enforce: **metering must never be able to
// slow down or fail the work it is metering.** The sensor-to-operator leg
// measures p95 ~2s end to end (NW-013), and essentially all of that is two
// deliberate constants with no slack in them. A synchronous Kafka produce
// per event, or an await on a broker that has gone away, would turn a
// billing feature into a latency regression and then into an outage.
//
// So: batched, fire-and-forget, bounded, and lossy under pressure — in that
// order of priority. Dropping a usage count is a billing inaccuracy.
// Blocking the pipeline is an incident. Those are not close.
import type { Producer } from "kafkajs";
import { topicName, type VektorEnv } from "@vektor/kafka";
import { USAGE_ACTION, USAGE_DOMAIN, type UsageEvent, type UsageMetric } from "./metrics.js";

export interface MeterOptions {
  env: VektorEnv;
  producer: Producer;
  /** Flush when this many events are buffered. */
  maxBatch?: number;
  /** Flush at least this often, even if the batch is not full. */
  flushIntervalMs?: number;
  /**
   * Hard ceiling on the buffer. Past this, new events are DROPPED and
   * counted in `droppedCount` rather than growing the buffer without
   * limit. An unbounded buffer in front of a broker that is down is just a
   * slower out-of-memory crash, and it takes the service with it.
   */
  maxBuffer?: number;
  /** Called on a failed flush. Default logs nothing — metering must be silent. */
  onError?(err: Error): void;
}

export interface Meter {
  /** Records usage. Returns immediately; never throws, never awaits a broker. */
  record(orgId: string, metric: UsageMetric, quantity?: number, attributes?: Record<string, string>): void;
  /** Forces a flush. Used at shutdown and in tests. */
  flush(): Promise<void>;
  /** Stops the timer and flushes what is buffered. */
  close(): Promise<void>;
  /** How many events have been dropped for buffer pressure since start. */
  readonly droppedCount: number;
}

export function createMeter(options: MeterOptions): Meter {
  const maxBatch = options.maxBatch ?? 500;
  const flushIntervalMs = options.flushIntervalMs ?? 5_000;
  const maxBuffer = options.maxBuffer ?? 50_000;
  const topic = topicName(options.env, USAGE_DOMAIN, USAGE_ACTION);

  let buffer: UsageEvent[] = [];
  let dropped = 0;
  let flushing: Promise<void> | undefined;

  const timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  // Metering must not be the reason a process refuses to exit.
  timer.unref?.();

  async function flush(): Promise<void> {
    // Serialise flushes. Two concurrent produces of overlapping slices is
    // how a batch gets counted twice, and double-counting is the billing
    // error a customer notices.
    if (flushing) return flushing;
    if (buffer.length === 0) return;

    const batch = buffer;
    buffer = [];
    flushing = (async () => {
      try {
        await options.producer.send({
          topic,
          messages: batch.map((event) => ({
            // Keyed by organisation so one org's events land on one
            // partition and the rollup consumer sees them in order.
            key: event.org_id,
            value: JSON.stringify(event),
          })),
        });
      } catch (err) {
        // Deliberately NOT re-buffered. A broker outage would otherwise
        // refill the buffer on every retry until it hits maxBuffer, by
        // which point the oldest events are gone anyway — and the retry
        // storm competes with the pipeline for the same broker. Losing a
        // period's counts is recoverable from the audit log; stalling
        // ingest is not.
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      } finally {
        flushing = undefined;
      }
    })();
    return flushing;
  }

  return {
    record(orgId, metric, quantity = 1, attributes = {}) {
      if (quantity <= 0) return;
      if (buffer.length >= maxBuffer) {
        dropped += 1;
        return;
      }
      buffer.push({
        org_id: orgId,
        metric,
        quantity,
        occurred_at: new Date().toISOString(),
        attributes,
      });
      if (buffer.length >= maxBatch) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
    get droppedCount() {
      return dropped;
    },
  };
}

/**
 * No-op meter. Services construct this when metering is not configured, so
 * call sites never need `meter?.record(...)` — an optional-chained metering
 * call is one that silently stops working when someone removes the `?.`.
 */
export function createNullMeter(): Meter {
  return {
    record() {},
    async flush() {},
    async close() {},
    droppedCount: 0,
  };
}
