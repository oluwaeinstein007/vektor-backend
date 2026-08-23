import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import blueForceRoutes from "./blueforce/routes.js";

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

  app.get("/healthz", async () => ({ status: "ok" }));

  app.register(blueForceRoutes);

  return app;
}
