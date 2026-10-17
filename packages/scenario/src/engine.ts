/**
 * NW-020 — the simulation engine: scenario time in, track state out.
 *
 * Deliberately pure. Nothing here reads the system clock, touches Kafka, or
 * performs I/O, which is what makes the determinism claim testable: given a
 * scenario, a seed and a time, `stateAt` always returns the same thing. The
 * player (player.ts) is the only part that knows what time it is.
 */
import { bearingDeg, haversineM, interpolate, MPS_TO_KMH, MPS_TO_KNOTS, type LatLon } from "./geo.js";
import { jitter, streamFor } from "./rng.js";
import type { Scenario, ScenarioEntity } from "./scenario.js";

export interface TrackState {
  entityId: string;
  /** Scenario-relative seconds. */
  t: number;
  lat: number;
  lon: number;
  alt_m: number;
  speed_mps: number;
  heading_deg: number;
}

/**
 * Where an entity is at scenario time `t`.
 *
 * Returns null before the track starts and after it ends rather than
 * clamping to the first/last waypoint. Clamping would park an entity at its
 * destination broadcasting forever, which looks like a stuck sensor and is
 * exactly the artefact that makes synthetic data untrustworthy.
 */
export function stateAt(entity: ScenarioEntity, t: number, seed: number): TrackState | null {
  const wps = entity.waypoints;
  const first = wps[0]!;
  const last = wps[wps.length - 1]!;
  if (t < first.t || t > last.t) return null;

  let i = 0;
  while (i < wps.length - 2 && wps[i + 1]!.t <= t) i++;
  const a = wps[i]!;
  const b = wps[i + 1]!;

  const span = b.t - a.t;
  const fraction = span <= 0 ? 0 : (t - a.t) / span;
  const pos = interpolate(a, b, fraction);

  const legM = haversineM(a, b);
  const speedMps = span <= 0 ? 0 : legM / span;
  // A dwell leg has no bearing of its own; carrying the heading from the
  // leg that arrived keeps a stationary vessel pointing the way it came
  // in, rather than snapping to north.
  const heading = legM < 0.5 ? headingInto(wps, i) : bearingDeg(a, b);

  const alt = interpolateAlt(a.alt_m, b.alt_m, fraction);

  if (entity.position_jitter_m > 0) {
    const rand = streamFor(seed, entity.id);
    // Advance the stream by the emission index so successive reports differ
    // while staying reproducible: jitter must be a function of (seed,
    // entity, t), never of how many times this function has been called.
    const step = Math.round(t / Math.max(entity.emit_interval_s, 1e-9));
    for (let k = 0; k < step * 2; k++) rand();
    const dLat = jitter(rand, entity.position_jitter_m) / 111_320;
    const dLon =
      jitter(rand, entity.position_jitter_m) /
      (111_320 * Math.max(0.01, Math.cos((pos.lat * Math.PI) / 180)));
    pos.lat += dLat;
    pos.lon += dLon;
  }

  return {
    entityId: entity.id,
    t,
    lat: pos.lat,
    lon: pos.lon,
    alt_m: alt,
    speed_mps: speedMps,
    heading_deg: heading,
  };
}

function headingInto(wps: { t: number; lat: number; lon: number }[], legIndex: number): number {
  for (let j = legIndex; j > 0; j--) {
    const from: LatLon = wps[j - 1]!;
    const to: LatLon = wps[j]!;
    if (haversineM(from, to) >= 0.5) return bearingDeg(from, to);
  }
  return 0;
}

function interpolateAlt(a: number | undefined, b: number | undefined, fraction: number): number {
  const from = a ?? 0;
  const to = b ?? from;
  return from + (to - from) * fraction;
}

/**
 * Scenario-relative emission times for one entity, over [fromT, toT).
 *
 * Half-open and anchored to absolute multiples of the interval rather than
 * to the window start, so the emission schedule is a property of the
 * scenario and not of how the player happens to slice time. Two runs with
 * different tick sizes therefore produce the same events — without that,
 * changing the tick would silently change the output and break determinism.
 */
export function emissionTimes(entity: ScenarioEntity, fromT: number, toT: number): number[] {
  const interval = entity.emit_interval_s;
  const start = entity.waypoints[0]!.t;
  const end = entity.waypoints[entity.waypoints.length - 1]!.t;

  const lo = Math.max(fromT, start);
  const hi = Math.min(toT, end + 1e-9);
  if (hi <= lo) return [];

  const firstIndex = Math.ceil((lo - start) / interval - 1e-9);
  const times: number[] = [];
  for (let k = firstIndex; ; k++) {
    const t = start + k * interval;
    if (t >= hi || t > end) break;
    times.push(Number(t.toFixed(6)));
  }
  return times;
}

/** Every entity's emissions over a window, in deterministic order. */
export function tick(scenario: Scenario, fromT: number, toT: number): TrackState[] {
  const out: TrackState[] = [];
  for (const entity of scenario.entities) {
    for (const t of emissionTimes(entity, fromT, toT)) {
      const state = stateAt(entity, t, scenario.seed);
      if (state) out.push(state);
    }
  }
  // Sorted by time, then by entity id: a stable total order is what makes
  // "byte-identical output" meaningful across runs.
  out.sort((x, y) => x.t - y.t || (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0));
  return out;
}
