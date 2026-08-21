import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import entitiesRoutes from "./routes/entities.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
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

  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(entitiesRoutes);

  return app;
}
