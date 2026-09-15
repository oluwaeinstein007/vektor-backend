import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import {
  upsertSensorRegistration,
  getSensorRegistration,
  listSensorRegistrations,
  deleteSensorRegistration,
} from "../src/sensors/queries.js";
import { toWireSensorRegistration } from "../src/sensors/mappers.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("registering a sensor persists it and re-registering the same sensor_id updates in place", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const sensorId = `test-sensor-${Date.now()}`;

  const first = await upsertSensorRegistration(db, {
    sensor_id: sensorId,
    sensor_type: "AIS",
    label: "Test AIS receiver",
    position: { lat: 51.9, lon: 4.5 },
    coverage_radius_m: 40_000,
  });
  assert.equal(first.sensor_id, sensorId);

  const second = await upsertSensorRegistration(db, {
    sensor_id: sensorId,
    sensor_type: "AIS",
    label: "Test AIS receiver (relocated)",
    position: { lat: 52.0, lon: 4.6 },
    coverage_radius_m: 60_000,
  });

  const fetched = await getSensorRegistration(db, sensorId);
  assert.ok(fetched);
  assert.equal(fetched!.label, "Test AIS receiver (relocated)");
  assert.equal(fetched!.coverage_radius_m, 60_000);
  assert.equal(second.sensor_id, sensorId);

  const all = await listSensorRegistrations(db);
  assert.equal(all.filter((r) => r.sensor_id === sensorId).length, 1, "re-registering must update, not duplicate");

  const wire = toWireSensorRegistration(fetched!);
  assert.deepEqual(wire.position, { lat: 52.0, lon: 4.6 });
  assert.equal(wire.sensor_type, "AIS");
  assert.equal(wire.coverage_radius_m, 60_000);

  // Plain awaited cleanup, not a second t.after() — t.after() hooks run
  // FIFO (registration order), so a later-registered delete would run
  // *after* the connection-close hook registered above, not before it.
  await deleteSensorRegistration(db, sensorId);
});
