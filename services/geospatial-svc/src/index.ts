import { createDb } from "@vektor/db";
import { authOptionsFromEnv } from "@vektor/auth";
import { createKafkaClient, topicName, type VektorEnv } from "@vektor/kafka";
import { buildApp } from "./app.js";
import { startHistoryProjector, applyRetention, type HistoryProjector } from "./history/writer.js";

const PORT = Number(process.env.PORT ?? 3005);
const DATABASE_URL = process.env.DATABASE_URL;

// NW-018. The projector is OPTIONAL: without KAFKA_BROKERS the service
// still serves every read route, the history ones simply return whatever is
// already in the table. That keeps the read API testable and deployable
// without standing up Kafka, and matches how pipeline.ts treats its own
// producer.
const KAFKA_BROKERS = process.env.KAFKA_BROKERS;
const VEKTOR_ENV = (process.env.VEKTOR_ENV ?? "dev") as VektorEnv;
// Default 7 days — see packages/db/src/schema/entityHistory.ts for why this
// is a configured window rather than "keep everything".
const HISTORY_RETENTION_DAYS = Number(process.env.HISTORY_RETENTION_DAYS ?? 7);
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const db = createDb(DATABASE_URL);
const app = buildApp({ db, auth: authOptionsFromEnv() });

let projector: HistoryProjector | null = null;
let retentionTimer: NodeJS.Timeout | null = null;

if (KAFKA_BROKERS) {
  const kafka = createKafkaClient({
    clientId: "geospatial-svc-history",
    brokers: KAFKA_BROKERS.split(","),
  });
  const topic = topicName(VEKTOR_ENV, "entities", "upserted");

  startHistoryProjector({
    kafka,
    db,
    topic,
    // A group id distinct from edge-sync-svc's: both consume this topic and
    // sharing a group would split the partitions between them, so each
    // would see only a fraction of the entities and silently record a
    // fraction of the history.
    // Namespaced by env — see fusion-svc/src/index.ts for why.
    groupId: `${VEKTOR_ENV}.geospatial-svc-history-projector`,
    onSkipped: (reason, detail) => app.log.warn({ reason, detail }, "history projector skipped a message"),
  })
    .then((started) => {
      projector = started;
      app.log.info({ topic }, "history projector running");
    })
    .catch((err: unknown) => app.log.error({ err }, "history projector failed to start"));

  // Retention runs on a timer rather than a cron container: dropping a day
  // partition is cheap and idempotent, so a missed run costs nothing and
  // the next one catches up.
  retentionTimer = setInterval(() => {
    applyRetention(db, HISTORY_RETENTION_DAYS)
      .then((dropped) => {
        if (dropped > 0) app.log.info({ dropped, retentionDays: HISTORY_RETENTION_DAYS }, "dropped history partitions");
      })
      .catch((err: unknown) => app.log.error({ err }, "history retention failed"));
  }, RETENTION_INTERVAL_MS);
  // Do not hold the process open purely for retention.
  retentionTimer.unref();
} else {
  app.log.warn("KAFKA_BROKERS unset — history projector disabled, read routes still served");
}

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`geospatial-svc listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

async function shutdown(signal: string) {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  if (retentionTimer) clearInterval(retentionTimer);
  if (projector) await projector.stop();
  await db.$client.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
