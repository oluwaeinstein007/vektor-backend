import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValidSensorTs, SensorTimestampError, MAX_SENSOR_CLOCK_SKEW_MS } from "../src/sensor-ts.js";

test("accepts a sensor_ts within the clock-skew window", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");
  assert.doesNotThrow(() => assertValidSensorTs("2026-08-21T00:00:01.000Z", "sensor-1", now));
});

test("rejects a non-ISO8601 sensor_ts", () => {
  assert.throws(() => assertValidSensorTs("not-a-timestamp", "sensor-1"), SensorTimestampError);
});

test("rejects a sensor_ts far in the past (broken/unsynced clock)", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");
  const tooOld = new Date(now.getTime() - MAX_SENSOR_CLOCK_SKEW_MS - 1).toISOString();
  assert.throws(() => assertValidSensorTs(tooOld, "sensor-1", now), SensorTimestampError);
});

test("rejects a sensor_ts far in the future", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");
  const tooFuture = new Date(now.getTime() + MAX_SENSOR_CLOCK_SKEW_MS + 1).toISOString();
  assert.throws(() => assertValidSensorTs(tooFuture, "sensor-1", now), SensorTimestampError);
});

test("accepts a sensor_ts exactly at the skew boundary", () => {
  const now = new Date("2026-08-21T00:00:00.000Z");
  const atBoundary = new Date(now.getTime() - MAX_SENSOR_CLOCK_SKEW_MS).toISOString();
  assert.doesNotThrow(() => assertValidSensorTs(atBoundary, "sensor-1", now));
});
