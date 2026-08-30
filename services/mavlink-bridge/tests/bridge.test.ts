import { test } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";
import type { MavlinkTelemetryPayload } from "@vektor/shared";
import { startMavlinkSource } from "../src/mavlinkSource.js";
import { startBridge } from "../src/bridge.js";
import { startFakeDrone } from "./helpers/fakeDrone.js";

const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL ?? "mqtt://localhost:11883";
const BRIDGE_RECEIVE_PORT = 14550;
const BRIDGE_SEND_PORT = 14555;

async function waitFor<T>(check: () => T | undefined, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

test("a real MAVLink GLOBAL_POSITION_INT packet flows through to a matching MQTT payload", async (t) => {
  const drone = await startFakeDrone(BRIDGE_RECEIVE_PORT, BRIDGE_SEND_PORT);
  t.after(() => drone.stop());

  const bridge = startBridge({
    brokerUrl: MQTT_BROKER_URL,
    topicPrefix: "vektor/sensors/mavlink",
    onError: (err) => t.diagnostic(`bridge error: ${err.message}`),
  });
  t.after(() => bridge.stop());

  const source = await startMavlinkSource({
    receivePort: BRIDGE_RECEIVE_PORT,
    sendPort: BRIDGE_SEND_PORT,
    ip: "127.0.0.1",
    onTick: (tick) => bridge.publish(tick),
    onError: (err) => t.diagnostic(`source error: ${err.message}`),
  });
  t.after(() => source.stop());

  const subscriber = mqtt.connect(MQTT_BROKER_URL);
  t.after(() => new Promise<void>((resolve) => subscriber.end(false, {}, () => resolve())));

  const received: Array<{ topic: string; payload: MavlinkTelemetryPayload }> = [];
  await new Promise<void>((resolve, reject) => {
    subscriber.on("connect", () => subscriber.subscribe("vektor/sensors/mavlink/#", (err) => (err ? reject(err) : resolve())));
    subscriber.on("error", reject);
  });
  subscriber.on("message", (topic, buf) => {
    received.push({ topic, payload: JSON.parse(buf.toString("utf-8")) as MavlinkTelemetryPayload });
  });

  // A UDP send can land before the subscriber's own subscription has
  // propagated on the broker — retry the send until at least one message
  // arrives, same race-avoidance pattern already established for Kafka
  // consumer-group rebalance delays elsewhere in this project.
  while (received.length === 0) {
    await drone.sendPosition(37.7749, -122.4194, 100, 45);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const { topic, payload } = await waitFor(() => received[0]);
  assert.equal(topic, "vektor/sensors/mavlink/1");
  assert.equal(payload.device_class, "mavlink");
  assert.equal(payload.system_id, 1);
  assert.ok(Math.abs(payload.lat - 37.7749) < 1e-5);
  assert.ok(Math.abs(payload.lon - -122.4194) < 1e-5);
  assert.ok(Math.abs(payload.alt_m - 100) < 0.01);
  assert.ok(payload.heading_deg !== null && Math.abs(payload.heading_deg - 45) < 0.01);
  assert.equal(payload.groundspeed_mps, 0); // fakeDrone.sendPosition doesn't set vx/vy
});

test("an UNKNOWN heading (UINT16_MAX sentinel) decodes to null, not a bogus 655.35-degree angle", async (t) => {
  const drone = await startFakeDrone(BRIDGE_RECEIVE_PORT + 2, BRIDGE_SEND_PORT + 2);
  t.after(() => drone.stop());

  const ticks: Array<{ headingDeg: number | null }> = [];
  const source = await startMavlinkSource({
    receivePort: BRIDGE_RECEIVE_PORT + 2,
    sendPort: BRIDGE_SEND_PORT + 2,
    ip: "127.0.0.1",
    onTick: (tick) => ticks.push(tick),
    onError: (err) => t.diagnostic(`source error: ${err.message}`),
  });
  t.after(() => source.stop());

  while (ticks.length === 0) {
    await drone.sendRawHeading(0, 0, 0, 65535); // UINT16_MAX — the spec's "unknown heading" sentinel
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(ticks[0]?.headingDeg, null);
});
