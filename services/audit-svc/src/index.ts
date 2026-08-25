import pino from "pino";
import { createDb } from "@vektor/db";
import { buildApp } from "./app.js";

const logger = pino({ name: "audit-svc" });

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 3009);

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const app = buildApp({ db });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "audit-svc listening");

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    await app.close();
    await db.$client.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start audit-svc");
  process.exit(1);
});
