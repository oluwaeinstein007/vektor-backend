import { test } from "node:test";
import assert from "node:assert/strict";
import { TrackManager, type TrackObservation } from "../src/pipeline/trackManager.js";
import { ExtendedKalmanFilter } from "../src/ekf/extendedKalmanFilter.js";

function manager(): TrackManager {
  return new TrackManager({ ekfFactory: (initial) => new ExtendedKalmanFilter(initial) });
}

function obs(overrides: Partial<TrackObservation>): TrackObservation {
  return {
    domain: "ais",
    sensor_id: "ais-1",
    position: { lat: 10, lon: 20, alt_m: 0 },
    classification: "Vessel.AIS",
    affiliation: "UNKNOWN",
    confidence: 0.9,
    sensor_ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("a second nearby, near-in-time observation correlates onto the same track", () => {
  const tm = manager();
  const first = tm.correlate(obs({}));
  assert.equal(first.isNew, true);

  const second = tm.correlate(
    obs({ sensor_ts: "2026-01-01T00:00:10.000Z", position: { lat: 10.0005, lon: 20.0005, alt_m: 0 } }),
  );
  assert.equal(second.isNew, false);
  assert.equal(second.track.entity_id, first.track.entity_id);
  assert.equal(second.track.source_sensors.size, 1); // same sensor_id both times
  assert.equal(tm.size, 1);
});

test("an observation far outside the gate spawns a new track instead of merging", () => {
  const tm = manager();
  const first = tm.correlate(obs({}));
  const second = tm.correlate(obs({ sensor_ts: "2026-01-01T00:00:10.000Z", position: { lat: 30, lon: 50, alt_m: 0 } }));

  assert.equal(second.isNew, true);
  assert.notEqual(second.track.entity_id, first.track.entity_id);
  assert.equal(tm.size, 2);
});

test("a second sensor within the gate adds itself to source_sensors and can widen affiliation", () => {
  const tm = manager();
  tm.correlate(obs({ sensor_id: "ais-1", affiliation: "UNKNOWN" }));
  const result = tm.correlate(
    obs({
      sensor_id: "ewrf-1",
      domain: "ewrf",
      affiliation: "HOSTILE",
      sensor_ts: "2026-01-01T00:00:05.000Z",
      position: { lat: 10.0002, lon: 20.0002, alt_m: 0 },
    }),
  );

  assert.equal(result.isNew, false);
  assert.deepEqual(Array.from(result.track.source_sensors).sort(), ["ais-1", "ewrf-1"]);
  assert.equal(result.track.affiliation, "HOSTILE", "a domain asserting a known affiliation should replace UNKNOWN");
});

test("REQ-3.5: conflicting high-confidence classifications on the same physical track flag CONFLICTED", () => {
  const tm = manager();
  tm.correlate(obs({ classification: "Vessel.AIS", confidence: 0.9 }));
  const result = tm.correlate(
    obs({
      sensor_id: "ewrf-1",
      domain: "ewrf",
      classification: "Vessel.Suspect",
      confidence: 0.8,
      sensor_ts: "2026-01-01T00:00:05.000Z",
      position: { lat: 10.0002, lon: 20.0002, alt_m: 0 },
    }),
  );

  assert.equal(result.track.status, "CONFLICTED");
});

test("evictStale marks a track LOST once it exceeds the timeout and stops it from being an association candidate", () => {
  const tm = new TrackManager({
    ekfFactory: (initial) => new ExtendedKalmanFilter(initial),
    lostTimeoutMs: 60_000,
  });
  tm.correlate(obs({ sensor_ts: "2026-01-01T00:00:00.000Z" }));

  const stillActive = tm.evictStale("2026-01-01T00:00:30.000Z");
  assert.deepEqual(stillActive, []);

  const justLost = tm.evictStale("2026-01-01T00:02:00.000Z");
  assert.equal(justLost.length, 1);
  assert.equal(justLost[0]!.status, "LOST");

  // A new observation that would otherwise have gated onto the lost track
  // should now spawn a fresh track instead.
  const after = tm.correlate(obs({ sensor_ts: "2026-01-01T00:02:05.000Z" }));
  assert.equal(after.isNew, true);
});
