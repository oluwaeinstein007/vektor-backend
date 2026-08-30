import pino from "pino";
import { createDb } from "@vektor/db";
import { createKafkaClient } from "@vektor/kafka";
import { authOptionsFromEnv } from "@vektor/auth";
import { buildApp } from "./app.js";
import { createRoutingClient, ensureRoutingSchema } from "./routing/client.js";
import { seedGrid } from "./routing/seedNetwork.js";
import { runInventoryCdcConsumer } from "./cdc/inventoryConsumer.js";
import { recomputeAllForecasts } from "./forecast/recompute.js";

const logger = pino({ name: "logistics-svc" });

const DATABASE_URL = process.env.DATABASE_URL;
const ROUTING_DATABASE_URL = process.env.ROUTING_DATABASE_URL;
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:9092";
// 3010 is coa-svc's default — this was a real, pre-existing collision.
const PORT = Number(process.env.PORT ?? 3014);
const FORECAST_INTERVAL_MS = Number(process.env.FORECAST_INTERVAL_MS ?? 15 * 60 * 1000); // REQ-6.1: every 15 min
const LEAD_TIME_HOURS = Number(process.env.LOW_STOCK_LEAD_TIME_HOURS ?? 24);

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!ROUTING_DATABASE_URL) throw new Error("ROUTING_DATABASE_URL is required");

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const routingSql = createRoutingClient(ROUTING_DATABASE_URL!);
  await ensureRoutingSchema(routingSql);

  const rows = await routingSql`SELECT count(*)::int AS n FROM road_nodes`;
  if ((rows[0] as { n: number }).n === 0) {
    logger.info("seeding synthetic road grid (no existing network found)");
    await seedGrid(routingSql);
  }

  const app = buildApp({ db, routingSql, auth: authOptionsFromEnv() });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "logistics-svc HTTP listening");

  const kafka = createKafkaClient({ clientId: "logistics-svc", brokers: KAFKA_BROKERS.split(",") });
  const consumer = kafka.consumer({ groupId: "logistics-svc" });
  await consumer.connect();
  const cdcPromise = runInventoryCdcConsumer({
    consumer,
    db,
    onApplied: (itemId, op) => logger.info({ itemId, op }, "applied ERP CDC change"),
    onError: (err) => logger.warn({ err }, "failed to apply CDC event"),
  });

  const forecastTimer = setInterval(() => {
    recomputeAllForecasts(db, {
      leadTimeHours: LEAD_TIME_HOURS,
      onLowStock: (itemId, message) => logger.warn({ itemId, message }, "low-stock alert fired"),
    }).catch((err: unknown) => logger.warn({ err }, "forecast recompute cycle failed"));
  }, FORECAST_INTERVAL_MS);

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    clearInterval(forecastTimer);
    await app.close();
    await consumer.disconnect();
    await routingSql.end();
    await db.$client.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await cdcPromise;
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start logistics-svc");
  process.exit(1);
});
