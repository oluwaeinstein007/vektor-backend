/**
 * NW-020 — the scenario file format.
 *
 * Zod rather than a hand-rolled parser for the same reason every contract
 * in this project is Zod: a scenario is authored by a human in a text
 * editor, so the failure mode to design for is a typo, and a parse error
 * naming the exact path beats `undefined is not an object` at playback
 * time against a live stack.
 *
 * These are scenario-authoring shapes, NOT wire contracts — they describe
 * intent ("this vessel goes here over an hour"), which the engine turns
 * into the real `@vektor/shared` sensor events. That is why they live here
 * rather than in vektor-proto: nothing outside this package ever sees them.
 */
import { z } from "zod";

export const Waypoint = z.object({
  /** Scenario-relative seconds from t=0. */
  t: z.number().nonnegative(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** Metres. Only meaningful for an air track. */
  alt_m: z.number().optional(),
});
export type Waypoint = z.infer<typeof Waypoint>;

/**
 * Which real sensor feed this entity appears on. The whole point is to
 * exercise the real adapters' contracts, so an entity is defined in terms
 * of the feed that would have observed it, not an abstract "target".
 */
export const TrackKind = z.enum(["ais", "adsb", "iot"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const ScenarioEntity = z
  .object({
    id: z.string().min(1),
    kind: TrackKind,
    /** How often this entity reports, in scenario seconds. */
    emit_interval_s: z.number().positive().default(10),
    /**
     * Waypoints must be sorted by t and have at least two entries — one
     * point is a position, not a track. Repeating a position is how a dwell
     * is expressed.
     */
    waypoints: z.array(Waypoint).min(2),
    /** Metres of positional noise, applied deterministically from the seed. */
    position_jitter_m: z.number().nonnegative().default(0),

    // Feed-specific identity. Validated per-kind by the refinement below
    // rather than as separate union members, because a union here produces
    // notoriously unreadable Zod errors for a human editing a JSON file.
    mmsi: z.string().regex(/^\d{9}$/).optional(),
    icao24: z.string().regex(/^[0-9A-F]{6}$/).optional(),
    callsign: z.string().nullable().optional(),
    device_id: z.string().optional(),
  })
  .superRefine((entity, ctx) => {
    for (let i = 1; i < entity.waypoints.length; i++) {
      if (entity.waypoints[i]!.t <= entity.waypoints[i - 1]!.t) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["waypoints", i, "t"],
          message: `waypoint times must strictly increase (${entity.waypoints[i]!.t} follows ${entity.waypoints[i - 1]!.t})`,
        });
      }
    }
    if (entity.kind === "ais" && !entity.mmsi) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["mmsi"], message: "an ais entity needs an mmsi" });
    }
    if (entity.kind === "adsb" && !entity.icao24) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["icao24"], message: "an adsb entity needs an icao24" });
    }
  });
export type ScenarioEntity = z.infer<typeof ScenarioEntity>;

export const Scenario = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /**
   * Everything random in a run derives from this. Changing it changes the
   * jitter and nothing else — the tracks themselves are fully specified by
   * the waypoints.
   */
  seed: z.number().int().default(1),
  /** Scenario length in seconds. Playback stops here, or loops. */
  duration_s: z.number().positive(),
  /** The receiver id reported on every event this scenario produces. */
  sensor_id: z.string().min(1).default("sim-sensor-1"),
  entities: z.array(ScenarioEntity).min(1),
});
export type Scenario = z.infer<typeof Scenario>;

export function parseScenario(raw: unknown): Scenario {
  return Scenario.parse(raw);
}
