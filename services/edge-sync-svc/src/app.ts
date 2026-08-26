import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Queue } from "bullmq";
import type { LocalStore } from "./db/localStore.js";
import syncRoutes from "./routes/sync.js";
import type { IntakeJob } from "./queue/intakeQueue.js";

export interface BuildAppOptions {
  store: LocalStore;
  intakeQueue: Queue<IntakeJob>;
  topic: string;
  partitions: number[];
  logger?: boolean;
}

/** Same index.ts/app.ts split as every other service: index.ts owns listen()/the consumer/worker lifecycle/shutdown, this just builds a fully wired app tests can drive via app.inject(). */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/", async () => ({
    service: "edge-sync-svc",
    status: "ok",
    endpoints: ["GET /healthz", "POST /sync/intake", "GET /sync/status"],
  }));

  app.register(syncRoutes, {
    store: options.store,
    intakeQueue: options.intakeQueue,
    topic: options.topic,
    partitions: options.partitions,
  });

  return app;
}
