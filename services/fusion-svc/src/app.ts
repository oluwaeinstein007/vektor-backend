import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import blueForceRoutes from "./blueforce/routes.js";
import sensorRoutes from "./sensors/routes.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
  logger?: boolean;
}

/** Same split as geospatial-svc's app.ts: index.ts owns listen()/shutdown, this just builds a fully wired app tests can drive via app.inject() without binding a port. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("db", options.db);

  // apps/web (a different origin/port) fetches the no-strike-zones REST
  // endpoint directly from the browser — permissive for now since this is
  // local dev tooling, not an internet-facing deployment.
  app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async () => ({
    service: "fusion-svc",
    status: "ok",
    endpoints: [
      "GET /healthz",
      "GET /api/v1/blue-force-assets",
      "POST /api/v1/blue-force-assets",
      "PUT /api/v1/blue-force-assets/:id",
      "DELETE /api/v1/blue-force-assets/:id",
      "GET /api/v1/no-strike-zones",
      "POST /api/v1/no-strike-zones",
      "DELETE /api/v1/no-strike-zones/:id",
      "GET /api/v1/sensors",
      "POST /api/v1/sensors",
      "DELETE /api/v1/sensors/:id",
      "Socket.IO gateway (entity:new/updated/lost, sensor:status)",
    ],
  }));

  app.register(blueForceRoutes);
  app.register(sensorRoutes);

  return app;
}
