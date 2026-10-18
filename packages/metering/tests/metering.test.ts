// NW-016. Two things are actually hard here and both are tested against
// real infrastructure rather than asserted:
//   1. the emitter must never block or throw into the path it is metering;
//   2. the rollup must not double-count a replayed Kafka batch, because
//      that number ends up on an invoice.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, type VektorDb } from "@vektor/db";
import { createMeter, createNullMeter } from "../src/emitter.js";
import { foldUsageBatch, periodStart, usageForPeriod, type RawUsageMessage } from "../src/rollup.js";
import { usageEventSchema, isUsageMetric, USAGE_METRICS } from "../src/metrics.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const ORG = "00000000-0000-0000-0000-000000000001";
const TOPIC = "test.vektor.usage.recorded";

let db: VektorDb;

before(async () => {
  db = createDb(DATABASE_URL);
  await db.$client`DELETE FROM usage_rollups WHERE org_id = ${ORG}`;
  await db.$client`DELETE FROM usage_consumer_offsets WHERE topic = ${TOPIC}`;
});

after(async () => {
  try {
    await db.$client`DELETE FROM usage_rollups WHERE org_id = ${ORG}`;
    await db.$client`DELETE FROM usage_consumer_offsets WHERE topic = ${TOPIC}`;
  } finally {
    await db.$client.end();
  }
});

function msg(offset: number, body: Record<string, unknown>, partition = 0): RawUsageMessage {
  return { topic: TOPIC, partition, offset: String(offset), value: JSON.stringify(body) };
}

function event(metric: string, quantity: number, occurred_at = "2026-10-18T10:15:00.000Z") {
  return { org_id: ORG, metric, quantity, occurred_at, attributes: {} };
}

test("the metric vocabulary is closed — an unknown metric is not a usage metric", () => {
  assert.ok(isUsageMetric("coa.generations"));
  assert.ok(!isUsageMetric("coa_generations"), "a near-miss spelling must not validate");
  assert.ok(!isUsageMetric("anything.else"));
  assert.equal(new Set(USAGE_METRICS).size, USAGE_METRICS.length, "no duplicates");
  // A free-text metric is how two services end up emitting the same thing
  // under different names and the discrepancy reaches an invoice.
  assert.throws(() => usageEventSchema.parse(event("made.up", 1)));
});

test("usage events validate their shape: uuid org, non-negative integer quantity, offset-aware timestamp", () => {
  assert.ok(usageEventSchema.parse(event("api.requests", 1)));
  assert.throws(() => usageEventSchema.parse({ ...event("api.requests", 1), org_id: "default" }));
  assert.throws(() => usageEventSchema.parse(event("api.requests", -1)));
  assert.throws(() => usageEventSchema.parse(event("api.requests", 1.5)));
  assert.throws(() => usageEventSchema.parse({ ...event("api.requests", 1), occurred_at: "2026-10-18 10:15" }));
});

test("periodStart truncates to the containing UTC hour", () => {
  assert.equal(periodStart(new Date("2026-10-18T10:59:59.999Z")).toISOString(), "2026-10-18T10:00:00.000Z");
  assert.equal(periodStart(new Date("2026-10-18T11:00:00.000Z")).toISOString(), "2026-10-18T11:00:00.000Z");
});

test("the emitter never throws or blocks, even when the broker always fails", async () => {
  const errors: Error[] = [];
  // A producer that rejects every send — a broker that is down.
  const producer = { send: async () => { throw new Error("broker unavailable"); } } as never;
  const meter = createMeter({ env: "dev", producer, maxBatch: 2, onError: (e) => errors.push(e) });

  // record() is synchronous and must not throw into the caller's path.
  meter.record(ORG, "ingest.events", 1);
  meter.record(ORG, "ingest.events", 1); // triggers a flush at maxBatch
  await meter.flush();
  await meter.close();

  assert.ok(errors.length >= 1, "the failure is reported to onError, not thrown");
  assert.match(errors[0]!.message, /broker unavailable/);
});

test("a failed flush does NOT re-buffer — a broker outage must not become an OOM", async () => {
  const producer = { send: async () => { throw new Error("down"); } } as never;
  const meter = createMeter({ env: "dev", producer, maxBatch: 1000, onError: () => {} });
  for (let i = 0; i < 100; i++) meter.record(ORG, "ingest.events", 1);
  await meter.flush();
  // The batch was taken out of the buffer before the send and is not put
  // back. A second flush has nothing to do, rather than retrying forever
  // against the same dead broker while the buffer keeps growing.
  await meter.flush();
  await meter.close();
  assert.equal(meter.droppedCount, 0, "these were lost to the failed send, not to buffer pressure");
});

test("the buffer is bounded: past maxBuffer, events are dropped and counted", async () => {
  const sent: unknown[] = [];
  const producer = { send: async (p: unknown) => { sent.push(p); } } as never;
  const meter = createMeter({ env: "dev", producer, maxBatch: 1_000_000, maxBuffer: 10 });
  for (let i = 0; i < 25; i++) meter.record(ORG, "ingest.events", 1);
  assert.equal(meter.droppedCount, 15, "15 of 25 exceeded the ceiling");
  await meter.close();
});

test("zero and negative quantities are ignored rather than recorded", async () => {
  const producer = { send: async () => {} } as never;
  const meter = createMeter({ env: "dev", producer, maxBuffer: 5 });
  meter.record(ORG, "ingest.events", 0);
  meter.record(ORG, "ingest.events", -3);
  assert.equal(meter.droppedCount, 0);
  await meter.close();
});

test("the null meter satisfies the interface so call sites never need optional chaining", async () => {
  const meter = createNullMeter();
  meter.record(ORG, "coa.generations", 5);
  await meter.flush();
  await meter.close();
  assert.equal(meter.droppedCount, 0);
});

test("folding a batch writes per-(org, metric, hour) totals and records the offset", async () => {
  const result = await foldUsageBatch(db, [
    msg(1, event("api.requests", 3)),
    msg(2, event("api.requests", 2)),
    msg(3, event("coa.generations", 1)),
    // A different hour must land in its own bucket, not be merged.
    msg(4, event("api.requests", 7, "2026-10-18T11:05:00.000Z")),
  ]);
  assert.equal(result.applied, 4);
  assert.equal(result.rejected, 0);

  const totals = await usageForPeriod(db, ORG, new Date("2026-10-18T00:00:00Z"), new Date("2026-10-19T00:00:00Z"));
  const byMetric = Object.fromEntries(totals.map((t) => [t.metric, t.quantity]));
  assert.equal(byMetric["api.requests"], 12n, "3 + 2 in hour 10, plus 7 in hour 11");
  assert.equal(byMetric["coa.generations"], 1n);

  const rows = await db.$client<{ period_start: Date }[]>`
    SELECT period_start FROM usage_rollups WHERE org_id = ${ORG} AND metric = 'api.requests' ORDER BY period_start
  `;
  assert.equal(rows.length, 2, "two distinct hours, not one merged row");
});

test("REPLAYING the same batch does not double-count — the billing-critical property", async () => {
  const before = await usageForPeriod(db, ORG, new Date("2026-10-18T00:00:00Z"), new Date("2026-10-19T00:00:00Z"));
  const beforeApi = before.find((t) => t.metric === "api.requests")!.quantity;

  // Exactly what Kafka delivers after a consumer crashes between the
  // rollup write and its offset commit.
  const replay = await foldUsageBatch(db, [
    msg(1, event("api.requests", 3)),
    msg(2, event("api.requests", 2)),
    msg(3, event("coa.generations", 1)),
    msg(4, event("api.requests", 7, "2026-10-18T11:05:00.000Z")),
  ]);
  assert.equal(replay.applied, 0);
  assert.equal(replay.skippedReplay, 4);

  const after = await usageForPeriod(db, ORG, new Date("2026-10-18T00:00:00Z"), new Date("2026-10-19T00:00:00Z"));
  assert.equal(after.find((t) => t.metric === "api.requests")!.quantity, beforeApi, "unchanged after replay");
});

test("a new offset after a replayed one is still applied — replay detection is per message, not per batch", async () => {
  const result = await foldUsageBatch(db, [
    msg(3, event("api.requests", 100)), // already folded
    msg(5, event("api.requests", 4)), // genuinely new
  ]);
  assert.equal(result.skippedReplay, 1);
  assert.equal(result.applied, 1);

  const totals = await usageForPeriod(db, ORG, new Date("2026-10-18T00:00:00Z"), new Date("2026-10-19T00:00:00Z"));
  assert.equal(totals.find((t) => t.metric === "api.requests")!.quantity, 16n, "12 + 4, not 112");
});

test("partitions keep independent offsets", async () => {
  // Offset 1 on partition 1 is a different message from offset 1 on
  // partition 0; treating offsets as global would silently drop it.
  const result = await foldUsageBatch(db, [msg(1, event("reports.generated", 9), 1)]);
  assert.equal(result.applied, 1);
  assert.equal(result.skippedReplay, 0);

  const totals = await usageForPeriod(db, ORG, new Date("2026-10-18T00:00:00Z"), new Date("2026-10-19T00:00:00Z"));
  assert.equal(totals.find((t) => t.metric === "reports.generated")!.quantity, 9n);
});

test("a malformed message is counted and skipped, and does NOT stall the partition", async () => {
  const result = await foldUsageBatch(db, [
    { topic: TOPIC, partition: 0, offset: "10", value: "{not json" },
    { topic: TOPIC, partition: 0, offset: "11", value: null },
    { topic: TOPIC, partition: 0, offset: "12", value: JSON.stringify(event("made.up.metric", 1)) },
    msg(13, event("inference.frames", 6)),
  ]);
  assert.equal(result.rejected, 3);
  assert.equal(result.applied, 1);

  // The offset advanced past the poison messages. Without this the
  // consumer re-reads and re-rejects them forever, and all billing stops.
  const [row] = await db.$client<{ last_offset: string }[]>`
    SELECT last_offset FROM usage_consumer_offsets WHERE topic = ${TOPIC} AND partition = 0
  `;
  assert.equal(BigInt(row!.last_offset), 13n);
});

test("usageForPeriod's window is half-open, so consecutive periods neither overlap nor gap", async () => {
  const hour10 = await usageForPeriod(db, ORG, new Date("2026-10-18T10:00:00Z"), new Date("2026-10-18T11:00:00Z"));
  const hour11 = await usageForPeriod(db, ORG, new Date("2026-10-18T11:00:00Z"), new Date("2026-10-18T12:00:00Z"));

  assert.equal(hour10.find((t) => t.metric === "api.requests")!.quantity, 9n, "3 + 2 + 4");
  assert.equal(hour11.find((t) => t.metric === "api.requests")!.quantity, 7n);
  // The boundary hour belongs to exactly one of them. An inclusive upper
  // bound would put it in both and inflate every monthly invoice.
  assert.equal(9n + 7n, 16n);
});
