import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import { vektorAuthPlugin, type JwtVerifierOptions } from "@vektor/auth";
import blueForceRoutes from "./blueforce/routes.js";
import sensorRoutes from "./sensors/routes.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  /**
   * Optional pipeline health probe. Omitted by tests and by any caller that
   * only serves the REST surface, in which case /healthz reports on the
   * HTTP server alone, as it always did.
   */
  pipelineHealth?: () => { healthy: boolean; consecutiveFailures: number; lastError?: string };
  db: VektorDb;
  auth: JwtVerifierOptions;
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
  app.register(vektorAuthPlugin, options.auth);

  // Reports the PIPELINE's health, not merely that Fastify is listening.
  //
  // This used to return a flat 200. A fusion-svc whose pipeline threw on
  // every cycle — a missing column after an unapplied migration, say —
  // served "ok" indefinitely while ingesting nothing: 117 consecutive
  // failures and a green healthcheck, observed. On Kubernetes that is the
  // worst available outcome, because the liveness probe passes and nothing
  // ever restarts or alerts. A service that is up but doing no work must
  // not claim to be healthy.
  //
  // Degraded only after several CONSECUTIVE failures, so a single transient
  // Redis or Postgres blip doesn't flap the probe.
  app.get("/healthz", async (_request, reply) => {
    const health = options.pipelineHealth?.();
    if (health && !health.healthy) {
      return reply.code(503).send({
        status: "degraded",
        reason: "pipeline failing",
        consecutive_failures: health.consecutiveFailures,
        last_error: health.lastError,
      });
    }
    return { status: "ok" };
  });

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
