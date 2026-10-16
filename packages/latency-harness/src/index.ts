// NW-013 — 00-vision.md §3.1 G1: "Compress decision loop — sensor-to-decision
// latency < 60 seconds." That is the product's headline claim and, until
// this existed, nothing measured it. Every component had been timed in
// isolation; the composed path never had.
//
// WHAT THIS MEASURES (honestly scoped): the sensor-to-operator leg.
//
//   t0  a real AisPositionReport is produced to {env}.vektor.ais.position
//        |  kafkajs produce -> broker ack
//   ..  a LIVE fusion-svc consumes it: Redis Streams event-time watermark
//       window, 6-state EKF, cross-sensor correlation, ontology mapping,
//       no-strike-zone check, Postgres upsert
//        |
//   t1  a real socket.io-client receives entity:new / entity:updated
//
// Every hop is the production code path against real infrastructure. There
// is no stub anywhere in it.
//
// WHAT IT DOES NOT MEASURE: the COA leg (fused entity -> ranked course of
// action). coa-svc needs a live Qdrant with a populated doctrine collection
// plus either a cloud gRPC LLM or a local GGUF, and the latency of that leg
// is dominated by model inference on hardware this project has never had
// (PERF-003/004 are blocked on exactly that). Reporting a number for it
// from a CPU-only dev box would be worse than reporting none. The figure
// this tool prints is therefore a LOWER BOUND on G1, and the right way to
// read it is: "G1 has <60s to spend; the pipeline up to the operator's
// screen costs this much of it."
//
// Correlation: each probe gets its own sensor_id, which fusion-svc carries
// through to the Entity's `source_sensors`, so a received entity maps back
// to exactly the message that produced it. No guessing by timestamp.
//
// Usage (with the compose stack up and a fusion-svc running):
//   KEYCLOAK_TOKEN=$(./scripts/dev-stack.sh token Analyst) \
//     pnpm --filter @vektor/latency-harness run
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createKafkaClient } from "@vektor/kafka";
import { AisPositionReport, type Entity } from "@vektor/shared";
import { io, type Socket } from "socket.io-client";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const FUSION_SVC_URL = process.env.FUSION_SVC_URL ?? "http://localhost:3007";
const TOKEN = process.env.KEYCLOAK_TOKEN;
// Must match the fusion-svc instance under test — it consumes
// `${VEKTOR_ENV}.vektor.ais.position`. Unlike @vektor/load-test (which
// deliberately uses an isolated namespace so it can't pollute a shared
// consumer), this harness MUST publish where the live service is listening;
// that is the whole point. Run it against a dev stack you own.
const ENV = process.env.VEKTOR_ENV ?? "dev";
const TOPIC = `${ENV}.vektor.ais.position`;
const SAMPLES = Number(process.env.LATENCY_SAMPLES ?? 30);
// Spacing matters: fusion-svc holds a Redis Streams watermark window
// (WATERMARK_MS, default 500) before releasing an observation, so probes
// fired faster than that batch together and the measurement stops being
// per-event. Default comfortably clears it.
const INTERVAL_MS = Number(process.env.LATENCY_INTERVAL_MS ?? 1500);
const TIMEOUT_MS = Number(process.env.LATENCY_TIMEOUT_MS ?? 30_000);

interface Pending {
  sentAt: number;
  resolve(latencyMs: number): void;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function makeReport(sensorId: string, seq: number): AisPositionReport {
  const now = new Date().toISOString();
  return AisPositionReport.parse({
    event_id: randomUUID(),
    sensor_id: sensorId,
    mmsi: String(900000000 + seq).slice(0, 9),
    message_type: 1,
    nav_status: 0,
    // Spread the probes so correlation can't merge two of them into one
    // track — a merged track would emit one entity for two probes and the
    // second would time out, which would look like a latency failure and
    // would not be one.
    lat: 59.0 + seq * 0.05,
    lon: 10.0 + seq * 0.05,
    speed_knots: 10,
    course_deg: 90,
    heading_deg: 90,
    sensor_ts: now,
    kafka_ts: now,
  });
}

async function main(): Promise<void> {
  if (!TOKEN) {
    throw new Error(
      "KEYCLOAK_TOKEN is required — fusion-svc's Socket.io handshake is RBAC-gated. " +
        "Mint one with: ./scripts/dev-stack.sh token Analyst",
    );
  }

  const pending = new Map<string, Pending>();

  const socket: Socket = io(FUSION_SVC_URL, { auth: { token: TOKEN }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (err) => reject(new Error(`socket connect failed: ${err.message}`)));
    setTimeout(() => reject(new Error("socket connect timed out")), 15_000);
  });
  console.log(`connected to fusion-svc at ${FUSION_SVC_URL}`);

  const onEntity = (entity: Entity): void => {
    for (const sensorId of entity.source_sensors) {
      const waiter = pending.get(sensorId);
      if (waiter) {
        pending.delete(sensorId);
        waiter.resolve(performance.now() - waiter.sentAt);
      }
    }
  };
  socket.on("entity:new", (e: Entity) => onEntity(e));
  socket.on("entity:updated", (e: { entity: Entity }) => onEntity(e.entity));

  const kafka = createKafkaClient({ brokers: KAFKA_BROKERS, clientId: "vektor-latency-harness" });
  const producer = kafka.producer();
  await producer.connect();

  const latencies: number[] = [];
  let timedOut = 0;

  console.log(`publishing ${SAMPLES} probes to ${TOPIC}, ${INTERVAL_MS}ms apart...`);
  for (let seq = 0; seq < SAMPLES; seq++) {
    const sensorId = `latency-probe-${Date.now()}-${seq}`;
    const report = makeReport(sensorId, seq);

    const settled = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(sensorId);
        resolve(null);
      }, TIMEOUT_MS);
      pending.set(sensorId, {
        sentAt: performance.now(),
        resolve: (ms) => {
          clearTimeout(timer);
          resolve(ms);
        },
      });
    });

    // sentAt is stamped inside the map above, immediately before the
    // produce call, so the measured interval includes the Kafka produce
    // round-trip — that cost is genuinely part of the pipeline.
    await producer.send({ topic: TOPIC, messages: [{ key: report.mmsi, value: JSON.stringify(report) }] });

    const ms = await settled;
    if (ms === null) {
      timedOut++;
      process.stdout.write("x");
    } else {
      latencies.push(ms);
      process.stdout.write(".");
    }
    if (seq < SAMPLES - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  process.stdout.write("\n");

  await producer.disconnect();
  socket.close();

  const sorted = [...latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  console.log("\n=== NW-013: sensor -> operator latency ===");
  console.log(`samples received : ${sorted.length}/${SAMPLES}${timedOut ? ` (${timedOut} timed out)` : ""}`);
  if (sorted.length > 0) {
    console.log(`min              : ${sorted[0]!.toFixed(1)} ms`);
    console.log(`mean             : ${mean.toFixed(1)} ms`);
    console.log(`p50              : ${percentile(sorted, 50).toFixed(1)} ms`);
    console.log(`p95              : ${percentile(sorted, 95).toFixed(1)} ms`);
    console.log(`p99              : ${percentile(sorted, 99).toFixed(1)} ms`);
    console.log(`max              : ${sorted[sorted.length - 1]!.toFixed(1)} ms`);
    console.log("\nNFR 8.1 reference points:");
    console.log(`  track fusion latency < 500ms   : ${percentile(sorted, 95) < 500 ? "PASS" : "OVER"} (p95)`);
    console.log(`  UI update latency   < 500ms    : included in the figure above, not separable here`);
    console.log(`  G1 sensor->decision < 60s      : this leg uses ${(percentile(sorted, 95) / 60_000 * 100).toFixed(2)}% of the budget (p95)`);
    console.log("\nThe COA leg is NOT included — see this file's header for why.");
  }
  if (sorted.length === 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
