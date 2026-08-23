// SVC-009: fused track -> canonical Entity (VEKTOR-PRD.md Epic 3). The only
// place a Track's in-memory EKF state gets turned into the wire contract —
// routed through Entity.parse(), not `as Entity`, so a future field added to
// either shape fails loudly here instead of silently drifting (same
// discipline as geospatial-svc's mappers/entity.ts).
import mgrsPkg from "mgrs"; // CJS-only, no ESM named export — see vektor-build-conventions memory
import { Entity } from "@vektor/shared";
import type { Track } from "../pipeline/trackManager.js";

const { forward: toMgrs } = mgrsPkg;

export interface MapToEntityOptions {
  noStrike: boolean;
}

export function mapToEntity(track: Track, options: MapToEntityOptions): Entity {
  const position = track.ekf.position;

  return Entity.parse({
    entity_id: track.entity_id,
    classification: track.classification,
    confidence: track.confidence,
    status: track.status,
    affiliation: track.affiliation,
    source_sensors: Array.from(track.source_sensors),
    position: {
      lat: position.lat,
      lon: position.lon,
      alt_m: position.alt_m,
      mgrs: toMgrs([position.lon, position.lat]),
      accuracy_m: track.ekf.accuracyM,
    },
    kinematics: {
      speed_kmh: track.ekf.speedKmh,
      heading_deg: track.ekf.headingDeg,
      trajectory: track.trajectory,
    },
    metadata: {
      tags: [],
      analyst_notes: "",
      no_strike: options.noStrike,
    },
    first_detected: track.first_detected,
    last_updated: track.last_sensor_ts,
  });
}
