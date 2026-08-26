// EDGE-005's backend half: apps/web's offline IndexedDB queue (the browser
// side, tested separately with a real headless browser) drains here once
// `navigator.onLine` flips back to true. BullMQ (§11.4's "Sync Queue"
// budget line) rather than a bare fetch-and-hope, so a write an operator
// made while genuinely offline gets retried with backoff instead of being
// silently lost the moment the field connection blips again mid-drain.
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type pino from "pino";
import { z } from "zod";

export const EDGE_SYNC_INTAKE_QUEUE = "edge-sync-intake";

// One variant today (UC-4.2's alert-triage-while-offline case); grows into
// z.discriminatedUnion("kind", [...]) the moment a second kind exists.
export const IntakeJob = z.object({
  kind: z.literal("alert-ack"),
  alert_id: z.string().uuid(),
  action: z.enum(["ACKNOWLEDGE", "ESCALATE", "DISMISS"]),
  operator_id: z.string().min(1),
  client_ts: z.string().datetime(),
});
export type IntakeJob = z.infer<typeof IntakeJob>;

export function bullmqConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
}

export function createIntakeQueue(redisUrl: string, queueName: string = EDGE_SYNC_INTAKE_QUEUE): Queue<IntakeJob> {
  return new Queue<IntakeJob>(queueName, { connection: bullmqConnection(redisUrl) });
}

export interface IntakeWorkerOptions {
  redisUrl: string;
  alertSvcUrl: string;
  logger: pino.Logger;
  // Overridable per-instance so tests can run isolated queues against the
  // same shared Redis without colliding — every real edge node deployment
  // just uses the default, one node's worker per its own local Redis.
  queueName?: string;
}

export function createIntakeWorker(options: IntakeWorkerOptions): Worker<IntakeJob> {
  return new Worker<IntakeJob>(
    options.queueName ?? EDGE_SYNC_INTAKE_QUEUE,
    async (job) => {
      switch (job.data.kind) {
        case "alert-ack": {
          const res = await fetch(`${options.alertSvcUrl}/api/v1/alerts/${job.data.alert_id}/actions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: job.data.action, operator_id: job.data.operator_id }),
          });
          // A 404 (the alert was deleted/never existed upstream) is not
          // retryable — surfacing it as a job failure would just retry
          // forever against the same permanent 404.
          if (!res.ok && res.status !== 404) {
            throw new Error(`alert-svc forward failed: HTTP ${res.status}`);
          }
          options.logger.info({ jobId: job.id, alertId: job.data.alert_id, status: res.status }, "forwarded queued alert action");
          break;
        }
      }
    },
    { connection: bullmqConnection(options.redisUrl) },
  );
}
