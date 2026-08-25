import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import type { Sql } from "postgres";
import inventoryRoutes from "./routes/inventory.js";
import buildRouteRoutes from "./routes/route.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
  routingSql: Sql;
  logger?: boolean;
}

/** Same split as every other service's app.ts: index.ts owns listen()/the CDC consumer/forecast scheduler/shutdown, this just builds a fully wired app tests can drive via app.inject(). */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("db", options.db);

  app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async () => ({
    service: "logistics-svc",
    status: "ok",
    endpoints: [
      "GET /healthz",
      "GET /api/v1/logistics/inventory",
      "POST /api/v1/logistics/route",
      "POST /api/v1/logistics/road-edges/:id/block",
      "Debezium CDC consumer (dev.vektor.erp.public.inventory, no HTTP surface)",
    ],
  }));

  app.register(inventoryRoutes);
  app.register(buildRouteRoutes(options.routingSql));

  return app;
}
