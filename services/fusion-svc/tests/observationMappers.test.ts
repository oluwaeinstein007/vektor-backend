import { test } from "node:test";
import assert from "node:assert/strict";
import { fromAis, fromAdsb, fromEwRf, fromIot } from "../src/pipeline/observationMappers.js";
import type { AisPositionReport, AdsbPositionReport, EwRfEmission, IotTelemetryEvent } from "@vektor/shared";

test("fromAis always produces an observation (Class A reports always carry a fix)", () => {
  const event: AisPositionReport = {
    event_id: "00000000-0000-0000-0000-000000000001",
    sensor_id: "ais-1",
    mmsi: "123456789",
    message_type: 1,
    nav_status: 0,
    lat: 10,
    lon: 20,
    speed_knots: 12,
    course_deg: 90,
    heading_deg: 90,
    sensor_ts: "2026-01-01T00:00:00.000Z",
    kafka_ts: "2026-01-01T00:00:00.100Z",
  };
  const obs = fromAis(event);
  assert.equal(obs.domain, "ais");
  assert.deepEqual(obs.position, { lat: 10, lon: 20, alt_m: 0 });
});

test("fromAdsb returns null when the report has no resolved lat/lon (common for early/partial SBS-1 messages)", () => {
  const event: AdsbPositionReport = {
    event_id: "00000000-0000-0000-0000-000000000002",
    sensor_id: "adsb-1",
    icao24: "ABCDEF",
    callsign: null,
    altitude_ft: 35000,
    ground_speed_kts: 450,
    track_deg: 270,
    lat: null,
    lon: null,
    vertical_rate_fpm: 0,
    squawk: null,
    on_ground: false,
    sensor_ts: "2026-01-01T00:00:00.000Z",
    kafka_ts: "2026-01-01T00:00:00.100Z",
  };
  assert.equal(fromAdsb(event), null);
});

test("fromAdsb converts altitude feet to meters when a position fix is present", () => {
  const event: AdsbPositionReport = {
    event_id: "00000000-0000-0000-0000-000000000003",
    sensor_id: "adsb-1",
    icao24: "ABCDEF",
    callsign: "UAL123",
    altitude_ft: 10000,
    ground_speed_kts: 450,
    track_deg: 270,
    lat: 40,
    lon: -70,
    vertical_rate_fpm: 0,
    squawk: "1200",
    on_ground: false,
    sensor_ts: "2026-01-01T00:00:00.000Z",
    kafka_ts: "2026-01-01T00:00:00.100Z",
  };
  const obs = fromAdsb(event);
  assert.ok(obs);
  assert.ok(Math.abs(obs.position.alt_m - 3048) < 0.1);
});

test("fromEwRf returns null for a bearing-only emission with no triangulated position", () => {
  const event: EwRfEmission = {
    event_id: "00000000-0000-0000-0000-000000000004",
    sensor_id: "ewrf-1",
    freq_mhz: 2400,
    bearing_deg: 45,
    signal_strength_dbm: -70,
    modulation: "FM",
    emitter_classification: null,
    sensor_position: { lat: 0, lon: 0 },
    estimated_position: null,
    sensor_ts: "2026-01-01T00:00:00.000Z",
    kafka_ts: "2026-01-01T00:00:00.100Z",
  };
  assert.equal(fromEwRf(event), null);
});

test("fromEwRf produces a low-confidence observation when a triangulated estimate is present", () => {
  const event: EwRfEmission = {
    event_id: "00000000-0000-0000-0000-000000000005",
    sensor_id: "ewrf-1",
    freq_mhz: 2400,
    bearing_deg: 45,
    signal_strength_dbm: -70,
    modulation: "FM",
    emitter_classification: "RadarType.Search",
    sensor_position: { lat: 0, lon: 0 },
    estimated_position: { lat: 5, lon: 6, accuracy_m: 5000 },
    sensor_ts: "2026-01-01T00:00:00.000Z",
    kafka_ts: "2026-01-01T00:00:00.100Z",
  };
  const obs = fromEwRf(event);
  assert.ok(obs);
  assert.equal(obs.classification, "RadarType.Search");
  assert.ok(obs.confidence < 0.5, "single-receiver RF geolocation should be low-confidence");
});

function iotEvent(payload: Record<string, unknown>): IotTelemetryEvent {
  return {
    event_id: "00000000-0000-0000-0000-000000000006",
    sensor_id: "iot-1",
    mqtt_topic: "test/topic",
    payload,
    sensor_ts: "2026-01-01T00:00:00.000Z",
    kafka_ts: "2026-01-01T00:00:00.100Z",
  };
}

test("fromIot returns null for a payload shape it doesn't recognize", () => {
  assert.equal(fromIot(iotEvent({ device_class: "some-unknown-sensor", foo: "bar" })), null);
});

test("fromIot recognizes a MAVLink-sourced payload as a friendly UAS track", () => {
  const obs = fromIot(
    iotEvent({
      device_class: "mavlink",
      system_id: 1,
      lat: 10,
      lon: 20,
      alt_m: 100,
      heading_deg: 90,
      groundspeed_mps: 5,
    }),
  );
  assert.ok(obs);
  assert.equal(obs.domain, "iot");
  assert.equal(obs.classification, "UAS.MAVLink");
  assert.equal(obs.affiliation, "FRIENDLY");
  assert.deepEqual(obs.position, { lat: 10, lon: 20, alt_m: 100 });
});

test("fromIot recognizes a field-pwa phone payload as a friendly field-operator track", () => {
  const obs = fromIot(
    iotEvent({
      device_class: "phone",
      lat: 30.0444,
      lon: 31.2357,
      alt_m: 42,
      gps_accuracy_m: 8.5,
      heading_deg: 270.5,
      pitch_deg: 1.2,
      roll_deg: -0.4,
      battery_pct: 87,
    }),
  );
  assert.ok(obs);
  assert.equal(obs.domain, "iot");
  assert.equal(obs.classification, "Personnel.FieldOperator");
  assert.equal(obs.affiliation, "FRIENDLY");
  assert.deepEqual(obs.position, { lat: 30.0444, lon: 31.2357, alt_m: 42 });
});
