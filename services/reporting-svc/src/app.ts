import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import { vektorAuthPlugin, type VektorAuthPluginOptions } from "@vektor/auth";
import buildReportRoutes from "./routes/reports.js";
import exportRoutes from "./routes/export.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
  storageDir: string;
  auth: VektorAuthPluginOptions;
  logger?: boolean;
}

/** Same split as every other service's app.ts: index.ts owns listen()/the report scheduler/shutdown, this just builds a fully wired app tests can drive via app.inject(). */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("db", options.db);

  app.register(cors, { origin: true });

  app.register(vektorAuthPlugin, options.auth);

  app.register(fastifySwagger, {
    openapi: { openapi: "3.1.0", info: { title: "VEKTOR reporting-svc API", version: "1.0.0" } },
    transform: jsonSchemaTransform,
  });
  app.register(fastifySwaggerUi, { routePrefix: "/documentation" });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async () => ({
    service: "reporting-svc",
    status: "ok",
    endpoints: [
      "GET /healthz",
      "POST /api/v1/reports",
      "GET /api/v1/reports/:id",
      "GET /api/v1/export?format=csv|geojson&from=&to=",
      "Cron-scheduled report dispatch (no HTTP surface)",
    ],
  }));

  app.register(buildReportRoutes(options.storageDir));
  app.register(exportRoutes);

  return app;
}
