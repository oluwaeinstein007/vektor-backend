/**
 * NW-020 — scenario plausibility checks.
 *
 * A scenario is authored by hand, and the easiest mistake to make is a leg
 * whose distance and duration imply a speed nothing of that kind can do.
 * The engine will happily play it: the waypoints are valid, the events are
 * schema-valid, and the only symptom is a cargo ship crossing a fjord at
 * 30 knots. Synthetic data that is quietly impossible is worse than no
 * synthetic data, because everything calibrated against it inherits the
 * error — so this is a first-class check, not a lint.
 *
 * Deliberately a WARNING, not a hard failure: a scenario may legitimately
 * want an implausible track (a missile, a deliberately anomalous contact to
 * test the EWMA anomaly detector). The author should be told, then trusted.
 */
import { haversineM, MPS_TO_KNOTS } from "./geo.js";
import type { Scenario, TrackKind } from "./scenario.js";

/**
 * Plausible speed envelope by feed type, in knots.
 *
 * A minimum matters as much as a maximum, and is the less obvious half: a
 * fixed-wing aircraft below roughly 90 knots is below stall speed and
 * would be falling out of the sky, which is just as impossible as a cargo
 * ship at 100 knots but reads as unremarkable in a table of numbers. A
 * vessel at 0 is fine — that is a moored ship — so the minimum only
 * applies to legs that actually cover ground.
 */
const PLAUSIBLE_KNOTS: Record<TrackKind, { min: number; max: number }> = {
  ais: { min: 0, max: 40 }, // a fast ferry tops out near 40; most cargo is 12-20
  adsb: { min: 90, max: 600 }, // below ~90kn a fixed wing is stalling
  iot: { min: 0, max: 200 }, // a drone or ground vehicle; stationary is normal
};

export interface LegReport {
  entityId: string;
  kind: TrackKind;
  legIndex: number;
  distanceM: number;
  durationS: number;
  speedKnots: number;
  implausible: boolean;
  reason?: string;
}

export function analyseScenario(scenario: Scenario): LegReport[] {
  const reports: LegReport[] = [];
  for (const entity of scenario.entities) {
    for (let i = 1; i < entity.waypoints.length; i++) {
      const a = entity.waypoints[i - 1]!;
      const b = entity.waypoints[i]!;
      const distanceM = haversineM(a, b);
      const durationS = b.t - a.t;
      const speedKnots = durationS > 0 ? (distanceM / durationS) * MPS_TO_KNOTS : 0;
      const bounds = PLAUSIBLE_KNOTS[entity.kind];
      // A stationary leg is a dwell, which is a deliberate construct, not a
      // vehicle moving impossibly slowly.
      const moving = distanceM > 1;
      let reason: string | undefined;
      if (speedKnots > bounds.max) reason = `too fast for ${entity.kind} (max ~${bounds.max}kn)`;
      else if (moving && speedKnots < bounds.min) reason = `too slow for ${entity.kind} (min ~${bounds.min}kn)`;

      reports.push({
        entityId: entity.id,
        kind: entity.kind,
        legIndex: i,
        distanceM,
        durationS,
        speedKnots,
        implausible: reason !== undefined,
        reason,
      });
    }
  }
  return reports;
}

export function formatAnalysis(reports: LegReport[]): string {
  const lines = ["entity            leg   distance    duration    speed", "------------------------------------------------------------"];
  for (const r of reports) {
    const flag = r.reason ? `  <-- ${r.reason}` : "";
    lines.push(
      `${r.entityId.padEnd(18)}${String(r.legIndex).padEnd(6)}` +
        `${(r.distanceM / 1000).toFixed(2).padStart(7)} km` +
        `${r.durationS.toFixed(0).padStart(9)} s` +
        `${r.speedKnots.toFixed(1).padStart(9)} kn${flag}`,
    );
  }
  return lines.join("\n");
}
