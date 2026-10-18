// packages/metering/src/metrics.ts — NW-016.
//
// The billable vocabulary. Deliberately a closed set: a free-text metric
// name means two services eventually emit `coa_generated` and
// `coa.generated` for the same thing, and the discrepancy is found by a
// customer reading an invoice rather than by a test.
//
// 19-commercialization.md's unit question is not settled — per sensor, per
// seat, per consumption, or a mix — so this records all four axes it could
// plausibly price on rather than pre-judging. Recording an unused metric
// costs one row per period; discovering a year later that the number you
// want to bill on was never counted costs the year.
import { z } from "zod";

export const USAGE_METRICS = [
  /** Sensor events accepted by ingest-svc, pre-fusion. The volume axis. */
  "ingest.events",
  /** Frames actually run through the CV model. The GPU-cost axis. */
  "inference.frames",
  /** COA generations. The axis closest to the product's actual value. */
  "coa.generations",
  /** Authenticated API requests, keyed per organisation. NW-017's axis. */
  "api.requests",
  /** Distinct sensors seen in the period. The per-sensor pricing axis. */
  "sensors.active",
  /** Reports rendered. Cheap to count, and a visible deliverable to a buyer. */
  "reports.generated",
] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

export function isUsageMetric(value: unknown): value is UsageMetric {
  return typeof value === "string" && (USAGE_METRICS as readonly string[]).includes(value);
}

/**
 * One usage observation.
 *
 * `quantity` rather than a bare increment because the cheap way to meter a
 * high-rate path is to batch locally and emit a total — a per-event Kafka
 * message for `ingest.events` at PERF-001's measured 9,889 events/sec would
 * cost more than the work being metered.
 *
 * `occurred_at` is the time of the WORK, not of the emission. Those differ
 * whenever an emitter batches or retries, and billing periods have edges:
 * an event batched at 23:59:58 and flushed at 00:00:01 belongs to the
 * earlier period, and taking the emission time would silently move revenue
 * between months.
 */
export const usageEventSchema = z.object({
  org_id: z.string().uuid(),
  metric: z.enum(USAGE_METRICS),
  quantity: z.number().int().nonnegative(),
  occurred_at: z.string().datetime({ offset: true }),
  /**
   * Free-form, for attribution rather than billing — which service emitted
   * it, which API key, which sensor. Never summed, never used to decide a
   * charge; it is what you read when a customer disputes a number.
   */
  attributes: z.record(z.string()).default({}),
});

export type UsageEvent = z.infer<typeof usageEventSchema>;

/** §12.3's {env}.vektor.{domain}.{action}. */
export const USAGE_DOMAIN = "usage";
export const USAGE_ACTION = "recorded";
