// Orchestrates one cycle of SVC-007..010: pull a watermark-ordered batch off
// Redis Streams, correlate each observation onto a track (SVC-007/dedup),
// EKF-smooth it (SVC-008), check it against no-strike zones (SVC-010), map
// it to the canonical Entity (SVC-009), persist it, and push the result out
// over the Socket.io gateway (§13.2) that apps/web's FE-002 has been
// waiting on since Phase 1.
import type { WatermarkWindow } from "@vektor/redis";
import type { VektorDb } from "@vektor/db";
import { AisPositionReport, AdsbPositionReport, EwRfEmission } from "@vektor/shared";
import { TrackManager, type TrackObservation } from "./trackManager.js";
import { ExtendedKalmanFilter } from "../ekf/extendedKalmanFilter.js";
import { fromAis, fromAdsb, fromEwRf } from "./observationMappers.js";
import { mapToEntity } from "../ontology/mapToEntity.js";
import { isInNoStrikeZone } from "../blueforce/queries.js";
import { upsertEntity } from "../db/upsertEntity.js";
import type { FusionGateway } from "../socket/gateway.js";

function toObservation(domain: string, payload: unknown): TrackObservation | null {
  switch (domain) {
    case "ais":
      return fromAis(AisPositionReport.parse(payload));
    case "adsb":
      return fromAdsb(AdsbPositionReport.parse(payload));
    case "ewrf":
      return fromEwRf(EwRfEmission.parse(payload));
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

    processed.push({ domain: event.domain, entityId: entity.entity_id, isNew, changedFields });
  }

  const nowIso = new Date().toISOString();
  for (const track of deps.trackManager.evictStale(nowIso)) {
    const entity = mapToEntity(track, { noStrike: false });
    await upsertEntity(deps.db, entity);
    deps.gateway.emitEntityLost(track.entity_id, entity.position, nowIso);
  }

  return processed;
}

export function createTrackManager(): TrackManager {
  return new TrackManager({ ekfFactory: (initial) => new ExtendedKalmanFilter(initial) });
}
