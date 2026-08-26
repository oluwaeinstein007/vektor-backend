import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import { vektorAuthPlugin, type VektorAuthPluginOptions } from "@vektor/auth";
import entitiesRoutes from "./routes/entities.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
  auth: VektorAuthPluginOptions;
  logger?: boolean;
}

/**
 * Separated from index.ts's listen() call specifically so tests can build
 * a fully wired app — real routes, real validation — and drive it via
 * `app.inject()` without binding a port or needing a live Postgres for the
 * request/response-shape tests (see tests/app.test.ts).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("db", options.db);

  app.register(vektorAuthPlugin, options.auth);

  // API-001/REQ-9.1: OpenAPI 3.1, generated from the same Zod route schemas
  // that already enforce request/response validation — not a hand-written
  // spec that can drift out of sync with what the handlers actually accept.
  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "VEKTOR geospatial-svc API", version: "1.0.0" },
    },
    transform: jsonSchemaTransform,
  });
  app.register(fastifySwaggerUi, { routePrefix: "/documentation" });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(entitiesRoutes);

  return app;
}
