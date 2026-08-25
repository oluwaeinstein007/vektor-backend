import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import zoneRoutes from "./routes/zones.js";
import alertRoutes from "./routes/alerts.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
  logger?: boolean;
}

/** Same split as fusion-svc's app.ts: index.ts owns listen()/the BullMQ worker/shutdown, this just builds a fully wired app tests can drive via app.inject() without binding a port or a worker. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("db", options.db);

  app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async () => ({
    service: "alert-svc",
    status: "ok",
    endpoints: [
      "GET /healthz",
      "GET /api/v1/geofence-zones",
      "POST /api/v1/geofence-zones",
      "DELETE /api/v1/geofence-zones/:id",
      "GET /api/v1/alerts",
      "POST /api/v1/alerts/:id/actions",
      "BullMQ worker (geofence-check queue, no HTTP surface)",
    ],
  }));

  app.register(zoneRoutes);
  app.register(alertRoutes);

  return app;
}
