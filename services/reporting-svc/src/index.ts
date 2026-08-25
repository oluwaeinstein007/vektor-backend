import { join } from "node:path";
import pino from "pino";
import { createDb } from "@vektor/db";
import { buildApp } from "./app.js";
import { runScheduledDispatchTick, createMailer } from "./schedule/scheduler.js";

const logger = pino({ name: "reporting-svc" });

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 3011);
const STORAGE_DIR = process.env.REPORT_STORAGE_DIR ?? join(process.cwd(), "storage");
const SMTP_URL = process.env.SMTP_URL ?? "smtp://localhost:1025";
const SMTP_FROM = process.env.SMTP_FROM ?? "reports@vektor.local";
const SCHEDULE_TICK_MS = Number(process.env.SCHEDULE_TICK_MS ?? 60_000); // cron granularity is minutes; a 60s tick is enough resolution

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const app = buildApp({ db, storageDir: STORAGE_DIR });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "reporting-svc HTTP listening");

  const mailer = createMailer(SMTP_URL);
  const scheduleTimer = setInterval(() => {
    runScheduledDispatchTick(
      { db, storageDir: STORAGE_DIR, mailer, mailFrom: SMTP_FROM, onError: (id, err) => logger.warn({ id, err }, "scheduled dispatch failed") },
    ).catch((err: unknown) => logger.warn({ err }, "schedule tick failed"));
  }, SCHEDULE_TICK_MS);

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    clearInterval(scheduleTimer);
    await app.close();
    await db.$client.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start reporting-svc");
  process.exit(1);
});
