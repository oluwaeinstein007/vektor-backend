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
  /**
   * Which sensor domains have contributed to this track. Needed by the
   * vertical correlation gate, which has to consider BOTH sides: the gate
   * for an incoming observation alone is not enough to decide whether its
   * altitude may legitimately differ from the track's.
   */
  source_domains: Set<string>;
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
  iot: 300, // direct GPS-derived MAVLink telemetry — tightest gate of any domain
};
const DEFAULT_GATE_METERS_FALLBACK = 2000;

/**
 * Vertical gate, in metres. The horizontal gate above was the ONLY gate
 * until 2026-10-17, which meant altitude never took part in correlation at
 * all — `haversineMeters` is a great-circle distance and discards alt_m
 * entirely. An aircraft at 3,000m overflying a vessel within ~1.5km
 * horizontally was therefore a correlation candidate, and the two were
 * merged into one track whose EKF settled at an averaged altitude
 * belonging to neither platform. One of the two real contacts simply
 * vanished from the operational picture, with no error and nothing visibly
 * wrong with the surviving entity.
 *
 * This is checked against the EKF's PREDICTED altitude rather than its last
 * measured one, so a genuinely climbing or descending aircraft still
 * correlates with itself — the 6-state filter tracks v_up_mps and
 * `extrapolate` already projects alt_m forward.
 *
 * `ewrf` is deliberately Infinity. RF geolocation produces a bearing/
 * position estimate with no usable altitude, so `EwRfEmission.estimated_position`
 * routinely carries alt 0 for an emitter that is actually airborne.
 * Applying a vertical gate to it would break SVC-011's entire purpose —
 * correlating an RF emission with the AIS or ADS-B track that produced it.
 * The gate used for a candidate pair is the MAXIMUM of the two sides'
 * gates, so an EW/RF track or observation on either side disables the
 * vertical check for that pair while leaving it in force everywhere else.
 */
const DEFAULT_VERTICAL_GATE_METERS: Record<string, number> = {
  // A vessel is at sea level. Anything a few hundred metres above it is
  // not that vessel.
  ais: 250,
  // Barometric altitude is quantised and the EKF's vertical-rate estimate
  // can drift over a long correlation gap, so this is deliberately loose —
  // it only has to separate platforms, not measure them.
  adsb: 1000,
  // GPS-derived MAVLink telemetry; good vertical accuracy.
  iot: 500,
  ewrf: Number.POSITIVE_INFINITY, // see above
};
const DEFAULT_VERTICAL_GATE_METERS_FALLBACK = 1000;
const MAX_TRAJECTORY_POINTS = 200;

export interface TrackManagerOptions {
  gateMeters?: Record<string, number>;
  /** Per-domain vertical gate in metres; see DEFAULT_VERTICAL_GATE_METERS. */
  verticalGateMeters?: Record<string, number>;
  correlationMaxGapSeconds?: number; // beyond this gap, don't associate — spawn a new track instead
  lostTimeoutMs?: number; // beyond this gap with no update at all, the track is LOST
  ekfFactory: (initial: GeoPosition) => ExtendedKalmanFilter;
}

export class TrackManager {
  private readonly tracks = new Map<string, Track>();
  private readonly gateMeters: Record<string, number>;
  private readonly verticalGateMeters: Record<string, number>;
  private readonly correlationMaxGapSeconds: number;
  private readonly lostTimeoutMs: number;
  private readonly ekfFactory: (initial: GeoPosition) => ExtendedKalmanFilter;

  constructor(options: TrackManagerOptions) {
    this.gateMeters = { ...DEFAULT_GATE_METERS, ...options.gateMeters };
    this.verticalGateMeters = { ...DEFAULT_VERTICAL_GATE_METERS, ...options.verticalGateMeters };
    this.correlationMaxGapSeconds = options.correlationMaxGapSeconds ?? 300;
    this.lostTimeoutMs = options.lostTimeoutMs ?? 5 * 60 * 1000;
    this.ekfFactory = options.ekfFactory;
  }

  private gateFor(domain: string): number {
    return this.gateMeters[domain] ?? DEFAULT_GATE_METERS_FALLBACK;
  }

  /**
   * The vertical gate for a candidate pair: the loosest of the observation's
   * domain and every domain already contributing to the track. Taking the
   * maximum (rather than the observation's alone) is what keeps an EW/RF
   * track correlatable with an aircraft — see DEFAULT_VERTICAL_GATE_METERS.
   */
  private verticalGateFor(obsDomain: string, trackDomains: Iterable<string>): number {
    let gate = this.verticalGateMeters[obsDomain] ?? DEFAULT_VERTICAL_GATE_METERS_FALLBACK;
    for (const d of trackDomains) {
      gate = Math.max(gate, this.verticalGateMeters[d] ?? DEFAULT_VERTICAL_GATE_METERS_FALLBACK);
    }
    return gate;
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
      if (distanceM > this.gateFor(obs.domain)) continue;

      // Vertical gate. Without this an aircraft overflying a ship merges
      // into the ship's track — see DEFAULT_VERTICAL_GATE_METERS.
      const verticalM = Math.abs(predicted.alt_m - obs.position.alt_m);
      if (verticalM > this.verticalGateFor(obs.domain, track.source_domains)) continue;

      if (!best || distanceM < best.distanceM) {
        best = { track, distanceM, dtSeconds };
      }
    }

    if (best) {
      const { track, dtSeconds } = best;
      if (dtSeconds > 0) track.ekf.predict(dtSeconds);
      track.ekf.update(obs.position);
      track.source_sensors.add(obs.sensor_id);
      track.source_domains.add(obs.domain);
      track.last_sensor_ts = obs.sensor_ts;
      track.trajectory.push({ lat: track.ekf.position.lat, lon: track.ekf.position.lon, ts: obs.sensor_ts });
      if (track.trajectory.length > MAX_TRAJECTORY_POINTS) track.trajectory.shift();

      // REQ-3.5: two sensors disagreeing on classification for what gating
      // decided is the same physical track — flag for analyst review rather
      // than silently picking one.
      const conflicting = obs.classification !== track.classification && obs.confidence > 0.5 && track.confidence > 0.5;
      // LATCHED, not recomputed. This used to be
      //   track.status = conflicting ? "CONFLICTED" : "ACTIVE"
      // which cleared the flag on the very next agreeing observation. Under
      // continuous dual-sensor input — the normal case — that meant the
      // flag flickered and whichever observation happened to arrive last
      // decided the stored status, so an operator would essentially never
      // see it. REQ-3.5 asks for disagreement to be flagged for analyst
      // review; a flag that erases itself does not do that. Once two
      // sensors have disagreed about what a track is, that happened, and
      // it stays visible until someone looks.
      if (conflicting) track.status = "CONFLICTED";
      else if (track.status !== "CONFLICTED") track.status = "ACTIVE";
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
      source_domains: new Set([obs.domain]),
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
