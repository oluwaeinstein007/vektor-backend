// Phase 5 integration point: every entity upsert this pipeline produces
// gets enqueued as a BullMQ job on the queue alert-svc's Worker consumes
// (§9.7: "fusion-svc -> alert-svc: BullMQ worker -> Geofence check ...").
// fusion-svc and alert-svc are siblings, not dependents of each other's
// `src` — this mirrors alert-svc's own queue/producer.ts rather than
// importing it, same as every other cross-service contract in this repo
// going through @vektor/proto/@vektor/shared instead of a direct import.
import { Queue, type ConnectionOptions } from "bullmq";
import { GEOFENCE_CHECK_QUEUE, type GeofenceCheckJob, type Entity } from "@vektor/shared";

export function bullmqConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
}

export function createGeofenceCheckQueue(redisUrl: string): Queue<GeofenceCheckJob> {
  return new Queue<GeofenceCheckJob>(GEOFENCE_CHECK_QUEUE, { connection: bullmqConnection(redisUrl) });
}

export function entityToGeofenceCheckJob(entity: Entity): GeofenceCheckJob {
  return {
    entity_id: entity.entity_id,
    affiliation: entity.affiliation,
    position: entity.position,
    speed_kmh: entity.kinematics.speed_kmh,
    heading_deg: entity.kinematics.heading_deg,
    ts: entity.last_updated,
  };
}

export async function enqueueGeofenceCheck(queue: Queue<GeofenceCheckJob>, entity: Entity): Promise<void> {
  await queue.add("check", entityToGeofenceCheckJob(entity), { removeOnComplete: 1000, removeOnFail: 1000 });
}
