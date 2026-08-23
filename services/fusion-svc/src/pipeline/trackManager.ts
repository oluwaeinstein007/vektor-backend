// REQ-3.1/REQ-3.5 (Phase 3): cross-sensor track correlation/dedup. One
// ExtendedKalmanFilter per physical track, kept in-process (same pattern as
// cv-inference-svc's DeepSORT tracker Map — no cross-restart persistence,
// the entities table is the durable output, not this in-memory index).
//
// Association is nearest-neighbor gating, not a full assignment solver
// (Hungarian/JPDA): for each incoming observation, dead-reckon every live
// track to the observation's sensor_ts and pick the closest one inside a
// domain-specific distance gate. This is deliberately the same complexity
// tradeoff cv-inference-svc's greedy IoU tracker made over the Hungarian
// algorithm (see that service's README) — adequate at this system's track
// density, much simpler to reason about and test.
import { randomUUID } from "node:crypto";
import type { ExtendedKalmanFilter, GeoPosition } from "../ekf/extendedKalmanFilter.js";
import { haversineMeters, extrapolate } from "./geo.js";

export type Affiliation = "UNKNOWN" | "FRIENDLY" | "HOSTILE" | "NEUTRAL";
export type TrackStatus = "ACTIVE" | "CONFLICTED" | "LOST";

export interface TrackObservation {
  domain: string; // "ais" | "adsb" | "ewrf"
  sensor_id: string;
  position: GeoPosition;
  classification: string;
  affiliation: Affiliation;
  confidence: number;
  sensor_ts: string;
}

export interface TrajectoryPoint {
  lat: number;
  lon: number;
  ts: string;
}

export interface Track {
  entity_id: string;
  ekf: ExtendedKalmanFilter;
  classification: string;
  confidence: number;
  affiliation: Affiliation;
  status: TrackStatus;
  source_sensors: Set<string>;
  trajectory: TrajectoryPoint[];
  first_detected: string;
  last_sensor_ts: string;
}

export interface CorrelationResult {
  track: Track;
  isNew: boolean;
}

const DEFAULT_GATE_METERS: Record<string, number> = {
  ais: 1500,
  adsb: 3000,
  ewrf: 8000, // RF geolocation is inherently much less precise than a GPS-derived fix
};
const DEFAULT_GATE_METERS_FALLBACK = 2000;
const MAX_TRAJECTORY_POINTS = 200;

export interface TrackManagerOptions {
  gateMeters?: Record<string, number>;
  correlationMaxGapSeconds?: number; // beyond this gap, don't associate — spawn a new track instead
  lostTimeoutMs?: number; // beyond this gap with no update at all, the track is LOST
  ekfFactory: (initial: GeoPosition) => ExtendedKalmanFilter;
}

export class TrackManager {
  private readonly tracks = new Map<string, Track>();
  private readonly gateMeters: Record<string, number>;
  private readonly correlationMaxGapSeconds: number;
  private readonly lostTimeoutMs: number;
  private readonly ekfFactory: (initial: GeoPosition) => ExtendedKalmanFilter;

  constructor(options: TrackManagerOptions) {
    this.gateMeters = { ...DEFAULT_GATE_METERS, ...options.gateMeters };
    this.correlationMaxGapSeconds = options.correlationMaxGapSeconds ?? 300;
    this.lostTimeoutMs = options.lostTimeoutMs ?? 5 * 60 * 1000;
    this.ekfFactory = options.ekfFactory;
  }

  private gateFor(domain: string): number {
    return this.gateMeters[domain] ?? DEFAULT_GATE_METERS_FALLBACK;
  }

  /** Correlates one observation against live tracks, updating the matched track's EKF or spawning a new one. */
  correlate(obs: TrackObservation): CorrelationResult {
    let best: { track: Track; distanceM: number; dtSeconds: number } | null = null;

    for (const track of this.tracks.values()) {
      if (track.status === "LOST") continue;
      const dtSeconds = (Date.parse(obs.sensor_ts) - Date.parse(track.last_sensor_ts)) / 1000;
      if (dtSeconds < 0 || dtSeconds > this.correlationMaxGapSeconds) continue;

      const predicted = extrapolate(track.ekf.position, track.ekf.velocity, dtSeconds);
      const distanceM = haversineMeters(predicted, obs.position);
      if (distanceM <= this.gateFor(obs.domain) && (!best || distanceM < best.distanceM)) {
        best = { track, distanceM, dtSeconds };
      }
    }

    if (best) {
      const { track, dtSeconds } = best;
      if (dtSeconds > 0) track.ekf.predict(dtSeconds);
      track.ekf.update(obs.position);
      track.source_sensors.add(obs.sensor_id);
      track.last_sensor_ts = obs.sensor_ts;
      track.trajectory.push({ lat: track.ekf.position.lat, lon: track.ekf.position.lon, ts: obs.sensor_ts });
      if (track.trajectory.length > MAX_TRAJECTORY_POINTS) track.trajectory.shift();

      // REQ-3.5: two sensors disagreeing on classification for what gating
      // decided is the same physical track — flag for analyst review rather
      // than silently picking one.
      const conflicting = obs.classification !== track.classification && obs.confidence > 0.5 && track.confidence > 0.5;
      track.status = conflicting ? "CONFLICTED" : "ACTIVE";
      track.confidence = Math.max(track.confidence, obs.confidence);
      if (obs.affiliation !== "UNKNOWN") track.affiliation = obs.affiliation;

      return { track, isNew: false };
    }

    const entity_id = randomUUID();
    const ekf = this.ekfFactory(obs.position);
    const track: Track = {
      entity_id,
      ekf,
      classification: obs.classification,
      confidence: obs.confidence,
      affiliation: obs.affiliation,
      status: "ACTIVE",
      source_sensors: new Set([obs.sensor_id]),
      trajectory: [{ lat: obs.position.lat, lon: obs.position.lon, ts: obs.sensor_ts }],
      first_detected: obs.sensor_ts,
      last_sensor_ts: obs.sensor_ts,
    };
    this.tracks.set(entity_id, track);
    return { track, isNew: true };
  }

  /** Marks any track untouched for longer than lostTimeoutMs as LOST and returns the ones that just transitioned, so the caller can emit entity:lost. */
  evictStale(nowIso: string): Track[] {
    const nowMs = Date.parse(nowIso);
    const justLost: Track[] = [];
    for (const track of this.tracks.values()) {
      if (track.status === "LOST") continue;
      if (nowMs - Date.parse(track.last_sensor_ts) > this.lostTimeoutMs) {
        track.status = "LOST";
        justLost.push(track);
      }
    }
    return justLost;
  }

  get(entityId: string): Track | undefined {
    return this.tracks.get(entityId);
  }

  get size(): number {
    return this.tracks.size;
  }
}
