// Orchestrates one cycle of SVC-007..010: pull a watermark-ordered batch off
// Redis Streams, correlate each observation onto a track (SVC-007/dedup),
// EKF-smooth it (SVC-008), check it against no-strike zones (SVC-010), map
// it to the canonical Entity (SVC-009), persist it, and push the result out
// over the Socket.io gateway (§13.2) that apps/web's FE-002 has been
// waiting on since Phase 1.
import type { Queue } from "bullmq";
import type { Producer } from "kafkajs";
import type { WatermarkWindow } from "@vektor/redis";
import type { VektorDb } from "@vektor/db";
import type { VektorEnv } from "@vektor/kafka";
import {
  AisPositionReport,
  AdsbPositionReport,
  EwRfEmission,
  IotTelemetryEvent,
  type GeofenceCheckJob,
} from "@vektor/shared";
import { TrackManager, type TrackObservation } from "./trackManager.js";
import { ExtendedKalmanFilter } from "../ekf/extendedKalmanFilter.js";
import { fromAis, fromAdsb, fromEwRf, fromIot } from "./observationMappers.js";
import { mapToEntity } from "../ontology/mapToEntity.js";
import { isInNoStrikeZone } from "../blueforce/queries.js";
import { upsertEntity } from "../db/upsertEntity.js";
import type { FusionGateway } from "../socket/gateway.js";
import { enqueueGeofenceCheck } from "../queue/geofenceProducer.js";
import { publishEntityUpserted } from "../kafka/entityProducer.js";

function toObservation(domain: string, payload: unknown): TrackObservation | null {
  switch (domain) {
    case "ais":
      return fromAis(AisPositionReport.parse(payload));
    case "adsb":
      return fromAdsb(AdsbPositionReport.parse(payload));
    case "ewrf":
      return fromEwRf(EwRfEmission.parse(payload));
    case "iot":
      return fromIot(IotTelemetryEvent.parse(payload));
    default:
      // "detection" (CV tracks) — no real-world position to correlate on yet, see observationMappers.ts.
      return null;
  }
}

export interface PipelineDeps {
  window: WatermarkWindow;
  trackManager: TrackManager;
  db: VektorDb;
  gateway: FusionGateway;
  // Optional so every pre-Phase-5 test of this pipeline keeps working
  // unchanged — alert-svc's geofence/anomaly checks are additive, not a
  // pipeline correctness dependency.
  geofenceQueue?: Queue<GeofenceCheckJob>;
  // Optional for the same reason — EDGE-006's durable entity topic is an
  // additive replay channel for edge-sync-svc, not a pipeline correctness
  // dependency. Requires env because the topic name is env-prefixed
  // (§12.3), same as every other topic this service touches.
  entityTopicProducer?: Producer;
  env?: VektorEnv;
}

export interface ProcessedEvent {
  domain: string;
  entityId: string;
  isNew: boolean;
  changedFields: string[];
}

/** One poll-and-process cycle. Call in a loop from index.ts's main run(); called directly (no loop) from tests. */
export async function runPipelineOnce(deps: PipelineDeps, blockMs: number): Promise<ProcessedEvent[]> {
  const batch = await deps.window.poll(blockMs);
  const processed: ProcessedEvent[] = [];

  for (const event of batch) {
    const obs = toObservation(event.domain, event.payload);
    if (!obs) continue;

    const { track } = deps.trackManager.correlate(obs);
    const noStrike = await isInNoStrikeZone(deps.db, track.ekf.position);
    const entity = mapToEntity(track, { noStrike });
    const { isNew, changedFields } = await upsertEntity(deps.db, entity);

    if (isNew) {
      deps.gateway.emitEntityNew(entity);
    } else if (changedFields.length > 0) {
      deps.gateway.emitEntityUpdated(entity.entity_id, changedFields, entity);
    }

    if (deps.geofenceQueue && (isNew || changedFields.length > 0)) {
      await enqueueGeofenceCheck(deps.geofenceQueue, entity);
    }

    if (deps.entityTopicProducer && deps.env && (isNew || changedFields.length > 0)) {
      await publishEntityUpserted(deps.entityTopicProducer, deps.env, {
        entity_id: entity.entity_id,
        entity,
        ts: entity.last_updated,
      });
    }

    processed.push({ domain: event.domain, entityId: entity.entity_id, isNew, changedFields });
  }

  const nowIso = new Date().toISOString();
  for (const track of deps.trackManager.evictStale(nowIso)) {
    const entity = mapToEntity(track, { noStrike: false });
    await upsertEntity(deps.db, entity);
    deps.gateway.emitEntityLost(track.entity_id, entity.position, nowIso);
    if (deps.entityTopicProducer && deps.env) {
      await publishEntityUpserted(deps.entityTopicProducer, deps.env, {
        entity_id: entity.entity_id,
        entity: null,
        ts: nowIso,
      });
    }
  }

  return processed;
}

export function createTrackManager(): TrackManager {
  return new TrackManager({ ekfFactory: (initial) => new ExtendedKalmanFilter(initial) });
}
