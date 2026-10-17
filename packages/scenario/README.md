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

## Usage

```bash
# check a scenario's legs are physically plausible before running it
pnpm --filter @vektor/scenario run scenarios/oslofjord.json --validate

# deterministic dump: every event, no Kafka, byte-identical across runs
pnpm --filter @vektor/scenario run scenarios/oslofjord.json --dry-run

# live playback at 10x onto the isolated `sim` namespace
KAFKA_BROKERS=localhost:19092 \
  pnpm --filter @vektor/scenario run scenarios/oslofjord.json --speed 10

# drive a fusion-svc that is listening on `perf.*`, looping forever
pnpm --filter @vektor/scenario run scenarios/oslofjord.json --env perf --loop
```

| flag | meaning |
|---|---|
| `--validate` | Report each leg's distance, duration and implied speed, flagging anything outside a plausible envelope for its feed type. |
| `--dry-run` | Print every event as JSON with scenario-relative timestamps and counter-derived ids. No Kafka. This is the determinism check. |
| `--speed N` | Scenario seconds per wall-clock second. **Read the caveat below before using anything but 1.** |
| `--loop` | Restart at t=0 on reaching `duration_s`. |
| `--env` | Topic namespace. Defaults to `sim`. |
| `--tick-ms` | Clock granularity. Does not affect which events are produced — see `emissionTimes`. |

## Writing a scenario

A scenario is entities with waypoints. Waypoint times are scenario-relative
seconds; repeating a position is how a dwell is expressed, and the engine
reports zero speed and holds the inbound heading through it.

```json
{
  "name": "Two vessels",
  "seed": 42,
  "duration_s": 3600,
  "sensor_id": "sim-receiver-1",
  "entities": [
    {
      "id": "cargo-inbound",
      "kind": "ais",
      "mmsi": "257123456",
      "emit_interval_s": 10,
      "position_jitter_m": 8,
      "waypoints": [
        { "t": 0,    "lat": 59.70, "lon": 10.45 },
        { "t": 1800, "lat": 59.80, "lon": 10.52 },
        { "t": 3600, "lat": 59.80, "lon": 10.52 }
      ]
    }
  ]
}
```

`kind` selects the real feed the entity appears on and therefore the
contract its events must satisfy: `ais` needs an `mmsi`, `adsb` needs an
`icao24`, and `iot` emits the MAVLink payload shape — specifically that
shape, because fusion-svc's IoT mapper discriminates on
`payload.device_class` and **silently skips** anything it does not
recognise, so a generic payload publishes happily and fuses into nothing.

Run `--validate` after editing. It catches the easy mistake — a leg whose
distance and duration imply a speed nothing of that kind can do — in both
directions. A cargo ship at 30 knots is as wrong as a fixed-wing aircraft
at 48 knots, and the second is the one people miss.

## Determinism, and its one limit

`--dry-run` output is byte-identical across runs for a given scenario and
seed: positions come from the waypoints, jitter from a seeded generator
keyed per entity, event ids from a counter, and timestamps from scenario
time. Nothing in `engine.ts`, `geo.ts`, `rng.ts` or `emit.ts` reads the
system clock.

Jitter is keyed on `(seed, entity id)` rather than drawn from one shared
stream on purpose: with a shared stream, adding an entity at the top of the
file would silently change every other entity's track, which makes a
scenario impossible to bisect against.

**Live playback cannot be deterministic in its timestamps**, and this is
not an oversight. `sensor_ts` must be wall-clock: fusion-svc's event-time
watermark and SVC-004's ingest-boundary clock check both compare it against
now, and a scenario-relative stamp is rejected as a broken sensor clock
(`MAX_SENSOR_CLOCK_SKEW_MS`, 5s). Positions stay deterministic; the clock
cannot. `--dry-run` is what you diff.

## Playback speed distorts derived kinematics

**Use `--speed 1` for anything where reported speed or heading matters.**

At higher speeds the positions advance at scenario rate while `sensor_ts`
advances at wall-clock rate, and fusion-svc's EKF derives velocity from the
gap between observations. The result is velocity multiplied by the playback
speed: a 13-knot cargo ship played at 30x was fused as **9,669 km/h**.

This is inherent to time compression, not a bug in either component — the
EKF is correctly computing speed from the timestamps it was given. It means
`--speed 30` is fine for a demo loop or for generating throughput, and
wrong for calibrating anything against the resulting kinematics.

## Known downstream behaviour this exposes

Running the worked example against a real fusion-svc surfaced a correlation
issue worth knowing about before you interpret scenario output: the
correlation gate in `services/fusion-svc/src/pipeline/trackManager.ts` is
**horizontal distance only**, so an aircraft overflying a vessel within the
gate merges into the vessel's track, and the two contacts become one entity
at an averaged altitude. If a scenario's entities cross in plan view, expect
fewer entities out than in. Reported to the service owner; not a scenario
bug.
