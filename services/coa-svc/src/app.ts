import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { VektorDb } from "@vektor/db";
import type { QdrantClient } from "@vektor/qdrant";
import coaRoutes from "./routes/coa.js";
import targetWorkbenchRoutes from "./routes/targetWorkbench.js";
import generateRoutes from "./routes/generate.js";
import { createAuditClient, type AuditClient } from "./audit/client.js";
import type { CoaMode } from "./llm/generateCoa.js";

declare module "fastify" {
  interface FastifyInstance {
    db: VektorDb;
  }
}

export interface BuildAppOptions {
  db: VektorDb;
  qdrant: QdrantClient;
  mode: CoaMode;
  auditSvcUrl: string;
  fusionSvcUrl: string;
  logger?: boolean;
  auditClient?: AuditClient; // test seam — inject a fake instead of a real fetch-based client
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate("db", options.db);

  app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async () => ({
    service: "coa-svc",
    status: "ok",
    mode: options.mode.kind,
    endpoints: [
      "GET /healthz",
      "GET /api/v1/coa/:situation_id",
      "GET /api/v1/coa/by-id/:coa_id",
      "POST /api/v1/coa/generate",
      "POST /api/v1/coa/:coa_id/approve",
      "POST /api/v1/coa/:coa_id/reject",
      "GET /api/v1/target-workbench/ranking",
    ],
  }));

  const auditClient = options.auditClient ?? createAuditClient(options.auditSvcUrl);

  app.register(coaRoutes, { auditClient });
  app.register(targetWorkbenchRoutes);
  app.register(generateRoutes, { qdrant: options.qdrant, mode: options.mode, fusionSvcUrl: options.fusionSvcUrl });

  return app;
}
