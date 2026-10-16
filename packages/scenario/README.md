# @vektor/scenario

**NW-020.** A deterministic scenario player: advances a scenario clock and
publishes schema-valid sensor events onto the real Kafka topics through the
real `@vektor/proto` contracts, at controllable speed.

Scaffolded by `vektor-0c`; the engine is `vektor-2e`'s work.

## Why this package exists

Three things in one build, per
[17-next-work.md](../../../vektor-docs/docs/17-next-work.md):

- **A repeatable input for the benchmarks.** `@vektor/latency-harness`
  (NW-013) and the map benchmark (NW-014) currently measure against
  whatever traffic happens to exist. A scenario gives the same input every
  run, which is the difference between a latency number you can quote and
  one you can defend.
- **Something to show on a deployed instance.** NW-004 needs the map to
  have something moving on it.
- **Operator training**, which cannot run against live sensors.

## Conventions this package must follow

**Schemas come from `@vektor/shared`, never from `@vektor/proto` directly
and never redeclared locally.** `packages/shared` exists precisely to be
the single re-export point — see its own package description and
VEKTOR-PRD.md §12.1. A scenario that invents its own event shapes stops
being a test of the real contracts.

**Default to an isolated topic namespace.** `packages/load-test`
established the pattern: it publishes to `loadtest.vektor.*` rather than
`dev.*` so it can never inject synthetic traffic into a `fusion-svc` that
someone else is running against a shared database. Default `VEKTOR_ENV` to
`sim`. Pointing at `dev` should be possible and opt-in, not the default —
and note that `@vektor/latency-harness` deliberately does the opposite, for
the opposite reason, and documents why.

**Determinism is the feature.** Same scenario plus same seed must produce
byte-identical output, or this is a demo toy rather than a test harness.
Take the seed explicitly; never read the system clock inside the simulation
path.
