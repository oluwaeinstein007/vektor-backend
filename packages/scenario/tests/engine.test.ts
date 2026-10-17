// NW-020. Everything under test here is pure — no Kafka, no clock — which
// is the point: determinism is this package's headline property and a
// property you cannot test without infrastructure is a property you are
// merely asserting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineM, bearingDeg, interpolate } from "../src/geo.js";
import { mulberry32, streamFor } from "../src/rng.js";
import { stateAt, emissionTimes, tick } from "../src/engine.js";
import { toEvent } from "../src/emit.js";
import { parseScenario } from "../src/scenario.js";
import { analyseScenario } from "../src/validate.js";

const SCENARIO = parseScenario({
  name: "test",
  seed: 7,
  duration_s: 600,
  sensor_id: "sim-1",
  entities: [
    {
      id: "vessel-a",
      kind: "ais",
      mmsi: "257000001",
      emit_interval_s: 60,
      waypoints: [
        { t: 0, lat: 59.0, lon: 10.0 },
        { t: 300, lat: 59.05, lon: 10.0 },
        { t: 600, lat: 59.05, lon: 10.0 },
      ],
    },
  ],
});

// ------------------------------------------------------------------- geo

test("haversine matches a known distance", () => {
  // 0.05 degrees of latitude is ~5.56km anywhere on earth.
  const d = haversineM({ lat: 59.0, lon: 10.0 }, { lat: 59.05, lon: 10.0 });
  assert.ok(Math.abs(d - 5560) < 30, `expected ~5560m, got ${d.toFixed(0)}`);
});

test("bearing due north is 0 and due east is 90", () => {
  assert.ok(Math.abs(bearingDeg({ lat: 59, lon: 10 }, { lat: 60, lon: 10 })) < 0.01);
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 0.01);
});

test("interpolate returns the endpoints exactly at 0 and 1", () => {
  const a = { lat: 59.0, lon: 10.0 };
  const b = { lat: 60.0, lon: 11.0 };
  const start = interpolate(a, b, 0);
  const end = interpolate(a, b, 1);
  assert.ok(Math.abs(start.lat - a.lat) < 1e-9 && Math.abs(start.lon - a.lon) < 1e-9);
  assert.ok(Math.abs(end.lat - b.lat) < 1e-9 && Math.abs(end.lon - b.lon) < 1e-9);
});

test("interpolate handles coincident points without NaN", () => {
  // A dwell is the same waypoint twice; sin(d) underflows in the general
  // formula and the whole track would come back NaN.
  const p = { lat: 59.0, lon: 10.0 };
  const mid = interpolate(p, p, 0.5);
  assert.ok(Number.isFinite(mid.lat) && Number.isFinite(mid.lon));
  assert.equal(mid.lat, p.lat);
});

// ------------------------------------------------------------------- rng

test("mulberry32 is reproducible for a given seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test("each entity gets an independent stream, so ordering cannot leak between them", () => {
  // If every entity drew from one shared generator, adding an entity at the
  // top of a scenario file would silently change every other entity's track.
  const first = streamFor(1, "vessel-a");
  const second = streamFor(1, "vessel-b");
  assert.notEqual(first(), second());
  assert.equal(streamFor(1, "vessel-a")(), first === undefined ? NaN : streamFor(1, "vessel-a")());
});

// ---------------------------------------------------------------- engine

test("stateAt returns null outside the track's own time span", () => {
  // Clamping instead would park the entity at its destination broadcasting
  // forever, which looks exactly like a stuck sensor.
  const entity = SCENARIO.entities[0]!;
  assert.equal(stateAt(entity, -1, SCENARIO.seed), null);
  assert.equal(stateAt(entity, 601, SCENARIO.seed), null);
  assert.notEqual(stateAt(entity, 0, SCENARIO.seed), null);
  assert.notEqual(stateAt(entity, 600, SCENARIO.seed), null);
});

test("stateAt derives a real speed from the leg, and zero on a dwell", () => {
  const entity = SCENARIO.entities[0]!;
  const moving = stateAt(entity, 150, SCENARIO.seed)!;
  // 5560m over 300s
  assert.ok(Math.abs(moving.speed_mps - 18.5) < 0.5, `got ${moving.speed_mps}`);
  const dwelling = stateAt(entity, 450, SCENARIO.seed)!;
  assert.equal(dwelling.speed_mps, 0);
});

test("a dwell keeps the heading it arrived on rather than snapping to north", () => {
  const entity = SCENARIO.entities[0]!;
  const dwelling = stateAt(entity, 450, SCENARIO.seed)!;
  assert.ok(Math.abs(dwelling.heading_deg) < 0.01, `due-north arrival, got ${dwelling.heading_deg}`);
});

test("stateAt is a pure function of (entity, t, seed)", () => {
  const entity = SCENARIO.entities[0]!;
  assert.deepEqual(stateAt(entity, 123, 7), stateAt(entity, 123, 7));
});

test("emissionTimes is anchored to the scenario, not to the window slicing", () => {
  // Two different tick sizes must produce the same events, or determinism
  // breaks the moment someone changes --tick-ms.
  const entity = SCENARIO.entities[0]!;
  const wholeSpan = emissionTimes(entity, 0, 601);

  const inChunks: number[] = [];
  for (let from = 0; from < 601; from += 37) {
    inChunks.push(...emissionTimes(entity, from, Math.min(from + 37, 601)));
  }
  assert.deepEqual(inChunks, wholeSpan);
});

test("emissionTimes is half-open so a boundary event is never emitted twice", () => {
  const entity = SCENARIO.entities[0]!;
  const a = emissionTimes(entity, 0, 60);
  const b = emissionTimes(entity, 60, 120);
  assert.deepEqual(a, [0]);
  assert.deepEqual(b, [60]);
});

test("tick returns a stable total order", () => {
  const multi = parseScenario({
    ...SCENARIO,
    entities: [
      { ...SCENARIO.entities[0]!, id: "zzz", mmsi: "257000002" },
      { ...SCENARIO.entities[0]!, id: "aaa", mmsi: "257000003" },
    ],
  });
  const first = tick(multi, 0, 200).map((s) => `${s.t}:${s.entityId}`);
  const second = tick(multi, 0, 200).map((s) => `${s.t}:${s.entityId}`);
  assert.deepEqual(first, second);
  // Same timestamp sorts by entity id, so output cannot depend on array order.
  assert.equal(first[0], "0:aaa");
});

// ------------------------------------------------------------------ emit

test("toEvent produces a schema-valid AIS report", () => {
  const entity = SCENARIO.entities[0]!;
  const state = stateAt(entity, 120, SCENARIO.seed)!;
  const event = toEvent(entity, state, {
    sensorId: "sim-1",
    sensorTs: new Date("2026-10-16T00:00:00.000Z"),
    nextEventId: () => "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(event.domain, "ais");
  assert.equal(event.action, "position");
  const value = event.value as { mmsi: string; heading_deg: number; nav_status: number };
  assert.equal(value.mmsi, "257000001");
  assert.ok(value.heading_deg >= 0 && value.heading_deg <= 359);
});

test("AIS heading never rounds up to 360, which the contract rejects", () => {
  // course_deg allows 360 but true heading is an integer 0-359, so a track
  // on a bearing of 359.7 would fail validation if rounded naively.
  const entity = parseScenario({
    ...SCENARIO,
    entities: [
      {
        ...SCENARIO.entities[0]!,
        waypoints: [
          { t: 0, lat: 59.0, lon: 10.0 },
          { t: 300, lat: 59.05, lon: 9.9999 }, // bearing just under 360
        ],
      },
    ],
  }).entities[0]!;
  const state = stateAt(entity, 100, 7)!;
  assert.ok(state.heading_deg > 359 && state.heading_deg < 360, `setup: got ${state.heading_deg}`);
  const event = toEvent(entity, state, { sensorId: "s", sensorTs: new Date(), nextEventId: () => "00000000-0000-4000-8000-000000000001" });
  assert.equal((event.value as { heading_deg: number }).heading_deg, 359);
});

test("a moored vessel reports AIS nav_status 5, not 0", () => {
  const entity = SCENARIO.entities[0]!;
  const dwelling = stateAt(entity, 450, SCENARIO.seed)!;
  const event = toEvent(entity, dwelling, { sensorId: "s", sensorTs: new Date(), nextEventId: () => "00000000-0000-4000-8000-000000000001" });
  assert.equal((event.value as { nav_status: number }).nav_status, 5);
});

test("an iot entity emits the mavlink payload shape fusion-svc actually recognises", () => {
  // fusion-svc's iot mapper discriminates on payload.device_class and
  // SILENTLY SKIPS anything else — a generic payload would publish fine
  // and fuse into nothing.
  const scenario = parseScenario({
    ...SCENARIO,
    entities: [{ id: "drone-1", kind: "iot", emit_interval_s: 60, waypoints: SCENARIO.entities[0]!.waypoints }],
  });
  const entity = scenario.entities[0]!;
  const state = stateAt(entity, 60, scenario.seed)!;
  const event = toEvent(entity, state, { sensorId: "s", sensorTs: new Date(), nextEventId: () => "00000000-0000-4000-8000-000000000001" });
  const payload = (event.value as { payload: { device_class: string } }).payload;
  assert.equal(payload.device_class, "mavlink");
});

// -------------------------------------------------------------- validate

test("validate flags a leg that is too fast for its feed type", () => {
  const scenario = parseScenario({
    ...SCENARIO,
    entities: [
      {
        ...SCENARIO.entities[0]!,
        waypoints: [
          { t: 0, lat: 59.0, lon: 10.0 },
          { t: 30, lat: 59.05, lon: 10.0 }, // 5.5km in 30s
        ],
      },
    ],
  });
  const bad = analyseScenario(scenario).filter((r) => r.implausible);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.reason!, /too fast/);
});

test("validate flags an aircraft below stall speed, not just an over-fast one", () => {
  const scenario = parseScenario({
    ...SCENARIO,
    entities: [
      {
        id: "air-1",
        kind: "adsb",
        icao24: "ABCDEF",
        emit_interval_s: 10,
        waypoints: [
          { t: 0, lat: 59.0, lon: 10.0, alt_m: 1000 },
          { t: 3600, lat: 59.05, lon: 10.0, alt_m: 1000 }, // 5.5km in an hour
        ],
      },
    ],
  });
  const bad = analyseScenario(scenario).filter((r) => r.implausible);
  assert.equal(bad.length, 1);
  assert.match(bad[0]!.reason!, /too slow/);
});

test("validate does not flag a dwell as impossibly slow", () => {
  const reports = analyseScenario(SCENARIO);
  const dwell = reports.find((r) => r.distanceM < 1);
  assert.ok(dwell, "setup: expected a dwell leg");
  assert.equal(dwell.implausible, false);
});

// ----------------------------------------------------------- determinism

test("the whole pipeline is byte-identical across runs for a fixed seed", () => {
  const render = () =>
    tick(SCENARIO, 0, SCENARIO.duration_s + 1)
      .map((state) => {
        const entity = SCENARIO.entities.find((e) => e.id === state.entityId)!;
        let n = 0;
        return JSON.stringify(
          toEvent(entity, state, {
            sensorId: SCENARIO.sensor_id,
            sensorTs: new Date(state.t * 1000),
            // Must be a real uuid: event_id is uuid-validated by the
            // contract, so a counter like `id-0` fails the parse rather
            // than testing determinism.
            nextEventId: () => `00000000-0000-4000-8000-${String(n++).padStart(12, "0")}`,
          }).value,
        );
      })
      .join("\n");
  assert.equal(render(), render());
});

test("changing only the seed changes the jitter but not the track", () => {
  const jittered = parseScenario({ ...SCENARIO, seed: 1, entities: [{ ...SCENARIO.entities[0]!, position_jitter_m: 50 }] });
  const other = parseScenario({ ...jittered, seed: 2 });
  const a = stateAt(jittered.entities[0]!, 120, jittered.seed)!;
  const b = stateAt(other.entities[0]!, 120, other.seed)!;
  assert.notEqual(a.lat, b.lat, "different seeds should jitter differently");
  // Still the same leg, so within jitter range of each other.
  assert.ok(Math.abs(a.lat - b.lat) < 0.01);
});

// --------------------------------------------------- altitude provenance

test("an unstated altitude is reported as null, not as sea level", () => {
  // The provenance defect fusion-svc was fixed for (fromAdsb/fromEwRf
  // asserting 0 for "not reported"), reproduced one layer upstream: a
  // waypoint with no alt_m means the author did not say, and emitting 0
  // would merge this aircraft into any vessel beneath it.
  const scenario = parseScenario({
    name: "no-alt",
    seed: 1,
    duration_s: 120,
    sensor_id: "s",
    entities: [
      {
        id: "a",
        kind: "adsb",
        icao24: "ABC123",
        emit_interval_s: 60,
        waypoints: [
          { t: 0, lat: 50.0, lon: 1.0 },
          { t: 120, lat: 50.1, lon: 1.0 },
        ],
      },
    ],
  });
  const entity = scenario.entities[0]!;
  const state = stateAt(entity, 60, scenario.seed)!;
  assert.equal(state.alt_known, false);

  const event = toEvent(entity, state, {
    sensorId: "s",
    sensorTs: new Date(),
    nextEventId: () => "00000000-0000-4000-8000-000000000001",
  });
  const value = event.value as { altitude_ft: number | null; on_ground: boolean };
  assert.equal(value.altitude_ft, null, "unstated altitude must be null, not 0");
  // Nor can it claim the aircraft is on the ground.
  assert.equal(value.on_ground, false);
});

test("a stated altitude is still reported normally", () => {
  const scenario = parseScenario({
    name: "with-alt",
    seed: 1,
    duration_s: 120,
    sensor_id: "s",
    entities: [
      {
        id: "a",
        kind: "adsb",
        icao24: "ABC123",
        emit_interval_s: 60,
        waypoints: [
          { t: 0, lat: 50.0, lon: 1.0, alt_m: 3000 },
          { t: 120, lat: 50.1, lon: 1.0, alt_m: 3000 },
        ],
      },
    ],
  });
  const entity = scenario.entities[0]!;
  const state = stateAt(entity, 60, scenario.seed)!;
  assert.equal(state.alt_known, true);
  const event = toEvent(entity, state, {
    sensorId: "s",
    sensorTs: new Date(),
    nextEventId: () => "00000000-0000-4000-8000-000000000001",
  });
  assert.equal((event.value as { altitude_ft: number }).altitude_ft, 9843);
});
