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

// ---------------------------------------------------------------------------
// Vertical correlation gate. Regression tests for a real bug found 2026-10-17
// by driving fusion-svc with a scenario (NW-020): the correlation gate was
// horizontal distance only, so an aircraft overflying a vessel was merged
// into the vessel's track and one of the two real contacts disappeared.
// ---------------------------------------------------------------------------

test("an aircraft at altitude is NOT merged into a surface vessel directly beneath it", () => {
  const m = manager();

  // A vessel at sea level.
  const ship = m.correlate(
    obs({ domain: "ais", sensor_id: "ais-ship", classification: "Vessel.AIS", position: { lat: 10, lon: 20, alt_m: 0 } }),
  );
  assert.equal(ship.isNew, true);

  // An aircraft at 3,000m on the SAME ground track — zero horizontal
  // separation, so the old horizontal-only gate matched it immediately.
  const aircraft = m.correlate(
    obs({
      domain: "adsb",
      sensor_id: "adsb-plane",
      classification: "Aircraft.ADSB",
      position: { lat: 10, lon: 20, alt_m: 3000 },
      sensor_ts: "2026-01-01T00:00:05.000Z",
    }),
  );

  assert.equal(aircraft.isNew, true, "the aircraft must spawn its own track, not join the vessel's");
  assert.notEqual(aircraft.track.entity_id, ship.track.entity_id);

  // And neither track's altitude is the average of the two. 1508.8 was the
  // observed symptom: an altitude belonging to neither platform.
  assert.ok(Math.abs(ship.track.ekf.position.alt_m) < 100, "vessel stays at sea level");
  assert.ok(aircraft.track.ekf.position.alt_m > 2500, "aircraft stays at altitude");
});

test("the same aircraft climbing still correlates with itself across a gap", () => {
  const m = manager();
  const first = m.correlate(
    obs({ domain: "adsb", sensor_id: "adsb-1", classification: "Aircraft.ADSB", position: { lat: 10, lon: 20, alt_m: 1000 } }),
  );
  // 30s later, 150m higher — a normal climb. The gate is checked against
  // the EKF's PREDICTED altitude, so this must still associate.
  const second = m.correlate(
    obs({
      domain: "adsb",
      sensor_id: "adsb-1",
      classification: "Aircraft.ADSB",
      position: { lat: 10, lon: 20, alt_m: 1150 },
      sensor_ts: "2026-01-01T00:00:30.000Z",
    }),
  );
  assert.equal(second.isNew, false, "a climbing aircraft must not be split into two tracks");
  assert.equal(second.track.entity_id, first.track.entity_id);
});

test("an EW/RF emission still correlates with an airborne track despite a meaningless altitude", () => {
  const m = manager();
  const aircraft = m.correlate(
    obs({ domain: "adsb", sensor_id: "adsb-1", classification: "Aircraft.ADSB", position: { lat: 10, lon: 20, alt_m: 3000 } }),
  );
  // RF geolocation yields no usable altitude — estimated_position carries 0
  // for an emitter that is genuinely at 3,000m. SVC-011 exists to correlate
  // exactly this, so the vertical gate must not block it.
  const emission = m.correlate(
    obs({
      domain: "ewrf",
      sensor_id: "ewrf-1",
      classification: "Aircraft.ADSB",
      position: { lat: 10, lon: 20, alt_m: 0 },
      sensor_ts: "2026-01-01T00:00:05.000Z",
    }),
  );
  assert.equal(emission.isNew, false, "EW/RF must still correlate — its altitude is not meaningful");
  assert.equal(emission.track.entity_id, aircraft.track.entity_id);
});

test("CONFLICTED latches — a later agreeing observation does not erase it", () => {
  const m = manager();
  m.correlate(obs({ sensor_id: "ais-1", classification: "Vessel.AIS", position: { lat: 10, lon: 20, alt_m: 0 } }));

  // A second sensor disagrees about what this is.
  const conflicted = m.correlate(
    obs({
      sensor_id: "ais-2",
      classification: "Vessel.Warship",
      position: { lat: 10, lon: 20, alt_m: 0 },
      sensor_ts: "2026-01-01T00:00:05.000Z",
    }),
  );
  assert.equal(conflicted.track.status, "CONFLICTED");

  // A third, agreeing observation used to reset this to ACTIVE, which is
  // how the flag became invisible under continuous input.
  const after = m.correlate(
    obs({
      sensor_id: "ais-1",
      classification: "Vessel.Warship",
      position: { lat: 10, lon: 20, alt_m: 0 },
      sensor_ts: "2026-01-01T00:00:10.000Z",
    }),
  );
  assert.equal(after.track.status, "CONFLICTED", "disagreement happened; it must stay visible until an analyst clears it");
});

test("an ADS-B report with NO altitude is not treated as a sea-level contact", () => {
  const m = manager();
  const ship = m.correlate(
    obs({ domain: "ais", sensor_id: "ais-ship", classification: "Vessel.AIS", position: { lat: 10, lon: 20, alt_m: 0 } }),
  );

  // AdsbPositionReport.altitude_ft is nullable and the mapper coerces null
  // to 0. Without alt_known that placeholder is indistinguishable from a
  // genuine sea-level fix, so the vertical gate would wave it through and
  // merge an aircraft into the vessel — the original bug, via a different
  // route. alt_known:false makes the gate decline to judge instead.
  const noAlt = m.correlate(
    obs({
      domain: "adsb",
      sensor_id: "adsb-noalt",
      classification: "Aircraft.ADSB",
      position: { lat: 10, lon: 20, alt_m: 0 },
      alt_known: false,
      sensor_ts: "2026-01-01T00:00:05.000Z",
    }),
  );

  // It still correlates — we cannot prove it is a different platform, and
  // splitting on invented data would be the worse error. What matters is
  // that the decision is made on the classification conflict, which is
  // real, rather than on a fabricated altitude.
  assert.equal(noAlt.isNew, false);
  assert.equal(noAlt.track.entity_id, ship.track.entity_id);
  assert.equal(noAlt.track.status, "CONFLICTED", "disagreeing classifications must still flag");
});
