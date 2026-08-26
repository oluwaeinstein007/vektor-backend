import pino from "pino";
import { createDb } from "@vektor/db";
import { createRedisClient } from "@vektor/redis";
import { authOptionsFromEnv } from "@vektor/auth";
import { buildApp } from "./app.js";
import { startAlertWorker } from "./queue/worker.js";
import { bullmqConnection } from "./queue/producer.js";
import { EwmaAnomalyDetector } from "./anomaly/ewmaDetector.js";
import { createEmailSender, createSmtpTransport, createTwilioSmsSender, createWebhookSender } from "./dispatch/channels.js";

const logger = pino({ name: "alert-svc" });

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 3009);
const SMTP_URL = process.env.SMTP_URL ?? "smtp://localhost:1025";
const SMTP_FROM = process.env.SMTP_FROM ?? "alerts@vektor.local";
const TWILIO_BASE_URL = process.env.TWILIO_BASE_URL ?? "https://api.twilio.com";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? "";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const redis = createRedisClient(REDIS_URL);

  const app = buildApp({ db, auth: authOptionsFromEnv() });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "alert-svc HTTP (geofence-zone/alert-triage REST) listening");

  const senders = {
    sendEmail: createEmailSender(createSmtpTransport(SMTP_URL), SMTP_FROM),
    sendSms: createTwilioSmsSender({
      baseUrl: TWILIO_BASE_URL,
      accountSid: TWILIO_ACCOUNT_SID,
      authToken: TWILIO_AUTH_TOKEN,
      fromNumber: TWILIO_FROM_NUMBER,
    }),
    sendWebhook: createWebhookSender(),
  };

  const worker = startAlertWorker(
    { db, redis, senders, detector: new EwmaAnomalyDetector() },
    bullmqConnection(REDIS_URL),
  );
  worker.on("failed", (job, err) => logger.warn({ jobId: job?.id, err }, "geofence-check job failed"));
  logger.info("alert-svc BullMQ worker started (geofence-check queue)");

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    await worker.close();
    await app.close();
    redis.disconnect();
    await db.$client.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start alert-svc");
  process.exit(1);
});
