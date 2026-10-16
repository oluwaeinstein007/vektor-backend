# @vektor/latency-harness

**NW-013.** Measures the real sensor-to-operator leg of G1
("sensor-to-decision latency < 60 seconds", `00-vision.md` §3.1).

Results and analysis live in
[`vektor-docs/docs/15-perf-results.md` §26a](../../../vektor-docs/docs/15-perf-results.md).

## What it measures

```
t0  a real AisPositionReport -> {env}.vektor.ais.position
      |  a LIVE fusion-svc: Redis Streams watermark window, 6-state EKF,
      |  cross-sensor correlation, ontology mapping, no-strike-zone
      |  check, Postgres upsert
t1  a real socket.io-client receives entity:new / entity:updated
```

Every hop is the production code path against real infrastructure. Probes
carry a unique `sensor_id` that `fusion-svc` propagates to the Entity's
`source_sensors`, so each received entity maps back to the exact message
that produced it — no timestamp matching.

## What it does not measure

The COA leg. `coa-svc` needs a live Qdrant with a populated doctrine
collection plus either a cloud gRPC LLM or a local GGUF, and that leg's
latency is dominated by model inference on hardware this project has never
had (PERF-003/004). **The number this prints is a lower bound on G1.**

## Running

Needs the compose stack up and a `fusion-svc` running against it.

```sh
pnpm stack:up
# ... start fusion-svc with compose/.env.example's values ...
KEYCLOAK_TOKEN=$(./scripts/dev-stack.sh token Analyst) \
  pnpm --filter @vektor/latency-harness run
```

| Env var | Default | Notes |
|---|---|---|
| `KEYCLOAK_TOKEN` | — | **Required.** fusion-svc's Socket.io handshake is RBAC-gated |
| `FUSION_SVC_URL` | `http://localhost:3007` | |
| `KAFKA_BROKERS` | `localhost:19092` | |
| `VEKTOR_ENV` | `dev` | Must match the fusion-svc under test |
| `LATENCY_SAMPLES` | `30` | |
| `LATENCY_INTERVAL_MS` | `1500` | Must exceed `WATERMARK_MS` or probes batch together |
| `LATENCY_TIMEOUT_MS` | `30000` | |

## Difference from `@vektor/load-test`

`@vektor/load-test` (PERF-001) measures **ingestion throughput** and
deliberately publishes to an isolated `loadtest.*` namespace so it can never
inject synthetic load into a shared `fusion-svc`.

This harness measures **end-to-end latency** and therefore *must* publish
where a live `fusion-svc` is listening. Run it against a dev stack you own,
not a shared one — it writes real entities into whatever Postgres that
`fusion-svc` points at.

## Interpreting the result

The default configuration carries a deliberate ~1.5 s floor:
`WATERMARK_MS` (500) + `POLL_BLOCK_MS` (1000). The watermark is what
satisfies Pitfall 1 — never order by arrival time — so tuning it down trades
correctness under sensor clock skew for latency. Measure both ways; the
perf doc records both.
