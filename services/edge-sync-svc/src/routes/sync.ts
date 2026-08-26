import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Queue } from "bullmq";
import type { LocalStore } from "../db/localStore.js";
import { IntakeJob } from "../queue/intakeQueue.js";

const IntakeAccepted = z.object({ accepted: z.literal(true), job_id: z.string() });
const StatusResponse = z.object({
  entity_count: z.number().int(),
  offsets: z.array(z.object({ topic: z.string(), partition: z.number().int(), offset: z.string() })),
});

export interface SyncRoutesOptions {
  store: LocalStore;
  intakeQueue: Queue<IntakeJob>;
  topic: string;
  partitions: number[];
}

const syncRoutes: FastifyPluginAsync<SyncRoutesOptions> = async (app, options) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // UC-4.2: a queued write (alert triage taken while offline) drains here
  // from apps/web's IndexedDB store once the edge node's connection comes
  // back — see queue/intakeQueue.ts's header comment.
  typedApp.post(
    "/sync/intake",
    { schema: { body: IntakeJob, response: { 202: IntakeAccepted } } },
    async (request, reply) => {
      const job = await options.intakeQueue.add(request.body.kind, request.body, {
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      return reply.code(202).send({ accepted: true, job_id: job.id ?? "" });
    },
  );

  typedApp.get("/sync/status", { schema: { response: { 200: StatusResponse } } }, async () => {
    const offsets = options.partitions
      .map((partition) => ({
        topic: options.topic,
        partition,
        offset: options.store.getOffset(options.topic, partition),
      }))
      .filter((o): o is { topic: string; partition: number; offset: bigint } => o.offset !== null)
      .map((o) => ({ topic: o.topic, partition: o.partition, offset: o.offset.toString() }));

    return { entity_count: options.store.countEntities(), offsets };
  });
};

export default syncRoutes;
