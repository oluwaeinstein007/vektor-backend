// NW-020 scaffold. The scenario engine is not written yet — this file
// exists so the workspace builds green while it is being developed, rather
// than leaving `pnpm build` red for everyone else in the meantime.
//
// See README.md for the three conventions this package has to follow:
// schemas come from @vektor/shared and are never redeclared; the default
// topic namespace is isolated (`sim`), following packages/load-test; and
// determinism is the feature, so the seed is explicit and nothing in the
// simulation path reads the system clock.

/** Scenario clock speed multiplier: 1 = real time, 60 = a 6-hour scenario in 6 minutes. */
export type SpeedMultiplier = number;

/** Placeholder — replaced by the real scenario schema (Zod, in src/schema.ts). */
export interface ScenarioPlaceholder {
  readonly name: string;
  readonly seed: number;
  readonly speed: SpeedMultiplier;
}

export const SCENARIO_DEFAULT_ENV = "sim";
