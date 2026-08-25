// Thin wrapper so both alert-svc's own tests and fusion-svc (the only
// external enqueuer — see fusion-svc/src/pipeline/pipeline.ts) create the
// BullMQ Queue the same way. BullMQ requires `maxRetriesPerRequest: null`
// on its own Redis connection (it manages retries itself via its blocking
// commands) — a connection shared with anything else that expects the
// ioredis default would silently break BullMQ's blocking polls.
import { Queue, type ConnectionOptions } from "bullmq";
import { GEOFENCE_CHECK_QUEUE, type GeofenceCheckJob } from "@vektor/shared";

export function bullmqConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    maxRetriesPerRequest: null,
  };
}

export function createGeofenceCheckQueue(redisUrl: string): Queue<GeofenceCheckJob> {
  return new Queue<GeofenceCheckJob>(GEOFENCE_CHECK_QUEUE, { connection: bullmqConnection(redisUrl) });
}

export async function enqueueGeofenceCheck(queue: Queue<GeofenceCheckJob>, job: GeofenceCheckJob): Promise<void> {
  await queue.add("check", job, { removeOnComplete: 1000, removeOnFail: 1000 });
}
