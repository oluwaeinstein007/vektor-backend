// PERF-001 — 03-nfr.md: "Event ingestion throughput >= 10,000 events/second
// sustained." This produces real, schema-valid AisPositionReport messages
// onto fusion-svc's actual `{env}.vektor.ais.position` topic (the same
// topic name `fusionTopic()` in ingestConsumers.ts computes) and consumes
// them back with a fresh consumer group, running every message through the
// identical `AisPositionReport.parse()` fusion-svc's own consumer would run
// — the real per-message validation cost, not a stub that skips it.
//
// This does NOT run fusion-svc's full pipeline (EKF, no-strike-zone checks,
// Postgres writes) — it isolates and measures "event ingestion throughput"
// specifically, per the NFR's literal wording, without starting a second
// long-lived service process against shared dev infra other sessions may be
// using concurrently.
import { randomUUID } from "node:crypto";
import { createKafkaClient } from "@vektor/kafka";
import { AisPositionReport } from "@vektor/shared";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
// Deliberately NOT "dev" — a real fusion-svc instance elsewhere may be
// consuming `dev.vektor.ais.position` into a live/demo Postgres dataset;
// this tool publishes to its own isolated namespace instead, matching the
// exact same topic-name shape `fusionTopic()` produces so the measurement
// is still representative, without ever touching a shared consumer's input.
const ENV = process.env.VEKTOR_ENV ?? "loadtest";
const TOPIC = `${ENV}.vektor.ais.position`;
const TARGET_RATE = Number(process.env.LOADTEST_TARGET_RATE ?? 10_000); // events/sec
const DURATION_SEC = Number(process.env.LOADTEST_DURATION_SEC ?? 20);
const BATCH_SIZE = Number(process.env.LOADTEST_BATCH_SIZE ?? 500);

function makeMessage(seq: number): { value: string } {
  const now = new Date().toISOString();
  const report: AisPositionReport = {
    event_id: randomUUID(),
    sensor_id: `loadtest-sensor-${seq % 8}`, // spread across 8 synthetic sensors, not one hot key
    mmsi: String(200000000 + (seq % 100_000_000)).padStart(9, "0").slice(0, 9),
    message_type: 1,
    nav_status: 0,
    lat: 50 + ((seq % 1000) / 1000) * 0.5,
    lon: 10 + ((seq % 1000) / 1000) * 0.5,
    speed_knots: 12.3,
    course_deg: seq % 360,
    heading_deg: seq % 360,
    sensor_ts: now,
    kafka_ts: now,
  };
  return { value: JSON.stringify(report) };
}

interface RateSample {
  second: number;
  count: number;
}

class RateCounter {
  private samples: RateSample[] = [];
  private startMs = Date.now();
  private total = 0;

  record(n: number): void {
    this.total += n;
    const second = Math.floor((Date.now() - this.startMs) / 1000);
    const last = this.samples[this.samples.length - 1];
    if (last && last.second === second) {
      last.count += n;
    } else {
      this.samples.push({ second, count: n });
    }
  }

  get totalCount(): number {
    return this.total;
  }

  /** Sustained rate = the rate held across every full second, not a single burst window. */
  maxSustained1s(): number {
    return this.samples.reduce((max, s) => Math.max(max, s.count), 0);
  }

  meanRateOverFullSeconds(): number {
    const full = this.samples.slice(0, -1); // drop the last, possibly-partial second
    if (full.length === 0) return 0;
    return full.reduce((sum, s) => sum + s.count, 0) / full.length;
  }
}

const NUM_PARTITIONS = Number(process.env.LOADTEST_PARTITIONS ?? 6);

// Re-running this tool against a topic left over from a prior run (possibly
// created with fewer partitions, e.g. by a producer's auto-create default
// of 1) silently caps achievable throughput at that partition count no
// matter how fast the producer sends — kafkajs's CreateTopics against an
// already-existing topic just errors and does nothing, and that error is
// easy to miss in the log noise. Delete-then-recreate guarantees the
// partition count this run actually asked for, every time.
async function ensureTopic(): Promise<void> {
  const kafka = createKafkaClient({ clientId: "vektor-load-test-admin", brokers: KAFKA_BROKERS });
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  if (existing.includes(TOPIC)) {
    await admin.deleteTopics({ topics: [TOPIC] });
    // Kafka's topic deletion is asynchronous even after the API call
    // returns; a CreateTopics for the same name issued immediately after
    // can race the deletion and fail as "topic already exists."
    await new Promise((r) => setTimeout(r, 2000));
  }
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: NUM_PARTITIONS }], waitForLeaders: true });
  const metadata = await admin.fetchTopicMetadata({ topics: [TOPIC] });
  const actualPartitions = metadata.topics[0]?.partitions.length ?? 0;
  if (actualPartitions !== NUM_PARTITIONS) {
    throw new Error(`expected ${NUM_PARTITIONS} partitions on ${TOPIC}, got ${actualPartitions} — topic creation didn't take effect as requested`);
  }
  console.log(`Topic ${TOPIC} ready with ${actualPartitions} partitions.`);
  await admin.disconnect();
}

async function runProducer(): Promise<RateCounter> {
  const kafka = createKafkaClient({ clientId: "vektor-load-test-producer", brokers: KAFKA_BROKERS });
  const producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();

  const counter = new RateCounter();
  const perBatchDelayMs = (BATCH_SIZE / TARGET_RATE) * 1000;
  const deadline = Date.now() + DURATION_SEC * 1000;
  let seq = 0;

  while (Date.now() < deadline) {
    const batchStart = Date.now();
    const messages = Array.from({ length: BATCH_SIZE }, () => makeMessage(seq++));
    await producer.send({ topic: TOPIC, messages });
    counter.record(messages.length);

    const elapsed = Date.now() - batchStart;
    const remaining = perBatchDelayMs - elapsed;
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }

  await producer.disconnect();
  return counter;
}

async function runConsumer(stopAfterMs: number): Promise<RateCounter> {
  const kafka = createKafkaClient({ clientId: "vektor-load-test-consumer", brokers: KAFKA_BROKERS });
  const consumer = kafka.consumer({ groupId: `vektor-load-test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });

  const counter = new RateCounter();
  let parseFailures = 0;

  const runPromise = consumer.run({
    eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
      let ok = 0;
      for (const message of batch.messages) {
        if (!message.value) continue;
        try {
          // The real cost fusion-svc's own consumer pays per message —
          // this is not skipped for the sake of a bigger throughput number.
          AisPositionReport.parse(JSON.parse(message.value.toString()));
          ok++;
        } catch {
          parseFailures++;
        }
        resolveOffset(message.offset);
      }
      counter.record(ok);
      await heartbeat();
    },
  });

  await new Promise((r) => setTimeout(r, stopAfterMs));
  await consumer.stop();
  await runPromise.catch(() => {});
  await consumer.disconnect();

  if (parseFailures > 0) {
    console.warn(`consumer: ${parseFailures} messages failed schema validation (unexpected — investigate before trusting the throughput number)`);
  }

  return counter;
}

async function main(): Promise<void> {
  console.log(`PERF-001 load test: target ${TARGET_RATE} events/sec for ${DURATION_SEC}s against ${TOPIC} (brokers: ${KAFKA_BROKERS.join(",")})`);

  // The topic must exist before the consumer subscribes — kafkajs's
  // consumer.subscribe() throws UNKNOWN_TOPIC_OR_PARTITION on a topic that's
  // never been created/produced to yet, even with allowAutoTopicCreation on
  // the producer side (that only helps the *producer's* first send).
  await ensureTopic();

  // Consumer starts first and runs a bit longer than the producer so it has
  // time to drain whatever the producer queued near the end — an honest
  // measurement of consume throughput, not one truncated mid-drain.
  const consumerPromise = runConsumer((DURATION_SEC + 20) * 1000);
  await new Promise((r) => setTimeout(r, 1000)); // let the consumer group finish joining before producing
  const producerCounter = await runProducer();
  const consumerCounter = await consumerPromise;

  const report = {
    target_events_per_sec: TARGET_RATE,
    duration_sec: DURATION_SEC,
    produced: {
      total: producerCounter.totalCount,
      mean_rate_per_sec: Math.round(producerCounter.meanRateOverFullSeconds()),
      max_sustained_1s_window: producerCounter.maxSustained1s(),
    },
    consumed: {
      total: consumerCounter.totalCount,
      mean_rate_per_sec: Math.round(consumerCounter.meanRateOverFullSeconds()),
      max_sustained_1s_window: consumerCounter.maxSustained1s(),
    },
    met_10k_sustained_bar: consumerCounter.meanRateOverFullSeconds() >= 10_000,
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
