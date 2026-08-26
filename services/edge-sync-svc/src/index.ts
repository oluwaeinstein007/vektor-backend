import pino from "pino";
import { createKafkaClient, topicName, type VektorEnv } from "@vektor/kafka";
import { openLocalStore } from "./db/localStore.js";
import { startDeltaSync } from "./sync/deltaSync.js";
import { createIntakeQueue, createIntakeWorker } from "./queue/intakeQueue.js";
import { buildApp } from "./app.js";

const logger = pino({ name: "edge-sync-svc" });

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:9092";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const VEKTOR_ENV = (process.env.VEKTOR_ENV ?? "dev") as VektorEnv;
const ALERT_SVC_URL = process.env.ALERT_SVC_URL ?? "http://localhost:3011";
const PORT = Number(process.env.PORT ?? 3012);
// Each physical edge node needs its own group so two Jetsons don't split
// one node's delta between them — see README.md.
const NODE_ID = process.env.VEKTOR_EDGE_NODE_ID;
const DB_PATH = process.env.EDGE_SYNC_DB_PATH ?? "./edge-sync.sqlite3";

if (!NODE_ID) {
  throw new Error("VEKTOR_EDGE_NODE_ID is required (identifies this edge node's own sync group/offset trail)");
}

async function main(): Promise<void> {
  const topic = topicName(VEKTOR_ENV, "entities", "upserted");
  const store = openLocalStore(DB_PATH);
  const kafka = createKafkaClient({ clientId: `edge-sync-svc-${NODE_ID}`, brokers: KAFKA_BROKERS.split(",") });

  const sync = await startDeltaSync({
    kafka,
    groupId: `edge-sync-svc-${NODE_ID}`,
    topic,
    store,
    onApplied: (msg) => logger.info({ entityId: msg.entity_id, lost: msg.entity === null }, "applied delta"),
  });

  const admin = kafka.admin();
  await admin.connect();
  const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
  const partitions = (metadata.topics[0]?.partitions ?? []).map((p) => p.partitionId);
  await admin.disconnect();

  const intakeQueue = createIntakeQueue(REDIS_URL);
  const intakeWorker = createIntakeWorker({ redisUrl: REDIS_URL, alertSvcUrl: ALERT_SVC_URL, logger });

  const app = buildApp({ store, intakeQueue, topic, partitions });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT, nodeId: NODE_ID, topic, entitiesSynced: store.countEntities() }, "edge-sync-svc listening");

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    await app.close();
    await sync.stop();
    await intakeWorker.close();
    await intakeQueue.close();
    store.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start edge-sync-svc");
  process.exit(1);
});
