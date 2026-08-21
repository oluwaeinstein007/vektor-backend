import { createDb } from "@vektor/db";
import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3005);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const db = createDb(DATABASE_URL);
const app = buildApp({ db });

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
  await db.$client.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
