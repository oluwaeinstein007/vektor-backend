# mavlink-bridge

Bridges a MAVLink v1/v2 telemetry source (a real flight controller/companion computer, or ArduPilot/PX4 SITL) to MQTT, republishing `GLOBAL_POSITION_INT` as a `device_class: "mavlink"` JSON payload on the same `vektor/sensors/...` topic tree ingest-svc's `mqttAdapter` already consumes. From there it flows through the existing SVC-003 MQTT path (`iot.telemetry` on Kafka) and `fusion-svc`'s `fromIot()` turns a recognized MAVLink payload into a `FRIENDLY` tracked entity — no new Kafka topic, no new fusion domain.

| Env var | Default | Purpose |
|---|---|---|
| `MQTT_BROKER_URL` | *(required)* | e.g. `mqtt://localhost:11883` |
| `MQTT_TOPIC_PREFIX` | `vektor/sensors/mavlink` | published as `{prefix}/{mavlink_system_id}` |
| `MAVLINK_RECEIVE_PORT` | `14550` | port this bridge listens on (MavEsp8266/GCS convention) |
| `MAVLINK_SEND_PORT` | `14555` | port this bridge sends its own Heartbeat to (ArduPilot SITL's `--out udpin:` default) |
| `MAVLINK_IP` | *(broadcast)* | target IP for outbound sends — set explicitly (`127.0.0.1` for local SITL) since most sandboxed/bridged Docker networks don't support broadcast |

Only `GLOBAL_POSITION_INT` is read — it alone carries lat/lon/alt/heading/groundspeed, so there's no need to also track `ATTITUDE`. The bridge sends a 1Hz `HEARTBEAT` back on the link (as `MAV_TYPE_ONBOARD_CONTROLLER` / `MAV_AUTOPILOT_INVALID`, i.e. a non-autopilot peer) — some MAVLink links (`mavlink-router`, GCS-side peer filters) stop routing to a peer that never sends its own Heartbeat, even a read-only one.

## Local development

Bring up the shared MQTT broker (same one ingest-svc's README documents) and a SITL source:

```bash
mkdir -p /tmp/vektor-mosquitto && printf 'listener 1883\nallow_anonymous true\n' > /tmp/vektor-mosquitto/mosquitto.conf
docker run -d --name vektor-dev-mosquitto -p 11883:1883 \
  -v /tmp/vektor-mosquitto/mosquitto.conf:/mosquitto/config/mosquitto.conf \
  eclipse-mosquitto:2

# Real ArduPilot SITL (needs the ardupilot repo + build toolchain — not
# vendored here, too heavy for this sandbox). If you have it:
Tools/autotest/sim_vehicle.py -v ArduCopter -f quad --console --map --out udpin:127.0.0.1:14555

pnpm build
MQTT_BROKER_URL=mqtt://localhost:11883 MAVLINK_IP=127.0.0.1 pnpm start
```

Then point ingest-svc's MQTT adapter at the same broker with a wildcard filter (`MQTT_TOPIC_FILTER='vektor/sensors/#'`, see `services/ingest-svc/README.md`) to see it flow all the way through to a tracked entity.

Without a real SITL install, `tests/helpers/fakeDrone.ts` (below) is a genuine MAVLink v2 UDP peer — same real-protocol-synthetic-source pattern ingest-svc's AIS/ADS-B adapter tests use — and is enough to exercise the whole bridge.

## Testing

```bash
MQTT_BROKER_URL=mqtt://localhost:11883 pnpm test
```

- `tests/bridge.test.ts` — a real `fakeDrone` (genuine MAVLink v2 `GLOBAL_POSITION_INT` packets over real UDP, via `node-mavlink`'s own encoder) sends telemetry to a real `startMavlinkSource`, whose ticks are published through a real `startBridge` to a real Mosquitto broker; a plain `mqtt` client in the test subscribes and verifies the resulting `device_class: "mavlink"` payload matches `MavlinkTelemetryPayload` exactly (decoded units: lat/lon degE7→deg, alt mm→m, heading cdeg→deg with the `UINT16_MAX` "unknown" sentinel mapped to `null`, groundspeed cm/s→m/s via `hypot(vx, vy)`).
