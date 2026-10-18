# `@vektor/connector-sdk`

**NW-019.** The interface a sensor connector is written against, plus three
reference implementations.

## Why this exists

Every adapter in `ingest-svc` — RTSP, AIS, ADS-B, MQTT, GeoTIFF, the field
PWA endpoint — was hand-written into the service, and each independently
repeats the same five steps: build an envelope with a fresh `event_id`,
stamp `kafka_ts`, assert `sensor_ts` is sane, validate against a Zod schema,
and produce to `{env}.vektor.{domain}.{action}`.

Five copies is five places for a difference to hide, and the differences are
already there. `aisAdapter` opens a TCP socket, reports errors to `onError`,
and **never reconnects** — when an AIS aggregator drops the connection, which
they do routinely, the feed stops, `ingest-svc` stays up and healthy, and
nothing says the sensor has gone quiet.

So the SDK is not only about third parties. It is the place reconnection,
validation and health accounting get done once, correctly.

## The contract

A connector produces domain events. It knows nothing about Kafka, topic
names, envelope fields, or validation — those are the runtime's job, and
keeping them there is what stops an external contributor from inventing
their own topic name or skipping the clock check.

```ts
import { z } from "zod";
import type { Connector, EventSpec } from "@vektor/connector-sdk";

const DoorEvent = z.object({
  event_id: z.string().uuid(),
  sensor_id: z.string().min(1),
  open: z.boolean(),
  sensor_ts: z.string().datetime({ offset: true }),
  kafka_ts: z.string().datetime({ offset: true }),
});

const DOOR: EventSpec<z.infer<typeof DoorEvent>> = {
  domain: "acme",
  action: "door",
  schema: DoorEvent,
};

export const acmeDoorConnector: Connector = {
  name: "acme-door",
  async start(ctx) {
    const timer = setInterval(() => {
      // event_id, sensor_id, sensor_ts and kafka_ts are filled in for you.
      void ctx.publish(DOOR, { open: true } as never);
    }, 5_000);
    return { stop: () => clearInterval(timer) };
  },
};
```

Run it:

```ts
const runtime = createConnectorRuntime({ producer, env: "dev" });
const running = await runtime.run(acmeDoorConnector, { sensorId: "door-1" });
// ...
console.log(runtime.health()); // per-connector counters
await runtime.stopAll();
```

## Things the runtime does that are easy to get wrong alone

- **It fills the envelope, but only what is missing.** If your device has its
  own synced clock, set `sensor_ts` yourself and it is kept. Overwriting a
  real timestamp with receipt time is how a real timestamp becomes a fake
  one, and `fusion-svc`'s watermark depends on the difference. `kafka_ts` is
  always the runtime's, because "when this entered the bus" is not something
  a connector can assert.

- **It checks the clock before the schema.** A plausible-looking event with a
  `sensor_ts` from next week passes any schema and then sits in `fusion-svc`'s
  watermark window holding back every other sensor.

- **A rejected event throws; a failed publish does not.** A rejected event
  (bad shape, bad clock) is your bug and you should be able to decide whether
  your feed can continue. A failed publish is usually the broker, and tearing
  down a live sensor feed because one send failed is the wrong response. They
  are counted separately for the same reason: one combined number hides a
  permanent defect inside what looks like transient noise.

- **`runWithReconnect` cannot deadlock your shutdown.** It races the session's
  `closed` promise against the stop signal, so a session whose `stop()` does
  not settle `closed` still shuts down. Backoff is exponential, capped, and
  jittered *symmetrically* — without jitter, every connector that lost the
  same broker reconnects at the same instants forever, which keeps the broker
  from recovering and makes the outage self-sustaining.

## Reference connectors

Three, deliberately of three different shapes — if the interface only fitted
pollers, it would be a poller framework wearing a connector's name.

| Connector | Shape | Status |
|---|---|---|
| `modbus-tcp` | polls outward on a timer | **Verified** against a real TCP server speaking real MBAP framing |
| `lorawan-webhook` | listens for inbound pushes | **Verified** against a real HTTP server, including auth and malformed bodies |
| `onvif-discovery` | resolves, on a sweep | **Partly verified** — parsing and SOAP envelopes tested against fixtures; never seen a real camera |

### `modbus-tcp`

Generic SCADA tap. [18-use-cases.md](../../../vektor-docs/docs/18-use-cases.md)
ranks critical infrastructure the strongest *commercial* fit, and Modbus is
what the equipment there actually speaks — pumps, breakers, RTUs, PLCs,
building management. "Does it support my sensor?" in that vertical usually
means "does it read Modbus registers?".

MBAP framing and function 3 are implemented directly, about forty lines, with
no external Modbus library — a dependency would be a larger surface than the
code it replaces. Handles register widths, sign, **word order** (`swapWords`,
because discovering byte-order trouble as "the pressure reading is 65536×
too big" is a bad afternoon) and scaling into engineering units.

**Read-only, permanently.** Modbus has no authentication of any kind, and a
connector that can write coils is a connector that can open a breaker. If
control ever becomes a product feature it should be a separate, explicitly
gated component — not a flag on this one.

### `lorawan-webhook`

Receives uplinks pushed by a network server (The Things Stack, ChirpStack,
Helium). Prefers the server's `decoded_payload`, keeps the raw base64 when no
decoder applies (an undecodable payload is still proof the device is alive —
dropping it makes a broken decoder look like a dead sensor), takes the
**strongest** gateway's RSSI rather than the first listed, and prefers the
gateway's `received_at` over local time.

Acks `204` **after** publication. A network server retrying on non-2xx is the
only redelivery mechanism there is; acking first turns a transient failure
into a lost uplink nothing can recover.

The shared secret is **required** — there is no "unauthenticated if unset"
escape. This endpoint injects readings into the fusion pipeline, so an open
one lets anybody on the network invent contacts.

### `onvif-discovery`

Answers "what cameras are on this network and what are their RTSP URLs"
without a human reading forty camera web UIs. `ingest-svc` already has a
working RTSP extractor; what it lacks is knowing where to point it.
[19-commercialization.md](../../../vektor-docs/docs/19-commercialization.md)
puts installation labour at 40–70% of project cost in this market, which is
what makes discovery worth more than it looks.

**Scope, plainly:** WS-Discovery probing plus the two SOAP calls that get from
a discovered device to a playable RTSP URI (`GetProfiles`, `GetStreamUri`). It
does **not** implement WS-UsernameToken digest auth, PTZ, or events. Cameras
requiring auth return 401 and are reported with `resolution_error` set rather
than silently skipped — a camera found but unresolvable is the most useful
thing an installer can be told.

**Not verified against real hardware.** No ONVIF device has existed in any
environment this was built in. First contact with a real camera will find
something; it always does. Same honesty [NW-012](../../../vektor-docs/docs/17-next-work.md)
applies to the Jetson.

## What this does not do yet

- **The existing `ingest-svc` adapters have not been ported onto it.** The SDK
  was shaped from their common structure and the reference connectors prove
  the interface across three shapes, but RTSP/AIS/ADS-B/MQTT/GeoTIFF still
  run their hand-written paths. Porting them is where the SDK pays for
  itself — in particular it is how `aisAdapter` gets reconnection — and it
  should be done one adapter at a time, each keeping its existing tests green.
- **No connector is registered in `ingest-svc`'s entrypoint.** Wiring is
  deliberately separate from the SDK landing, so the interface can be
  reviewed before the service depends on it.
