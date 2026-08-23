import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import modelsRoutes from "./routes/models.js";
import type { DetectionModel } from "./inference/session.js";

export interface BuildAppOptions {
  model: DetectionModel;
  requireGpu: boolean;
  logger?: boolean;
}

/**
 * Separated from index.ts's Kafka-consumer/process-lifecycle concerns for
 * the same reason geospatial-svc splits app.ts from index.ts: tests can
 * drive the real hot-swap route via app.inject() without a live Kafka
 * broker.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.get("/healthz", async () => ({
    status: "ok" as const,
    executionProvider: options.model.executionProvider,
  }));

  app.register(modelsRoutes, { getModel: () => options.model, requireGpu: options.requireGpu });

  return app;
}
