import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters, bearingDegrees } from "../src/threat/geo.js";

test("haversineMeters of a point to itself is 0", () => {
  assert.equal(haversineMeters({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }), 0);
});

test("haversineMeters of one degree of longitude at the equator is roughly 111km", () => {
  const d = haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert.ok(d > 110_000 && d < 112_000);
});

test("bearingDegrees due north is 0", () => {
  const b = bearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(b - 0) < 0.01);
});

test("bearingDegrees due east is 90", () => {
  const b = bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  assert.ok(Math.abs(b - 90) < 0.01);
});

test("bearingDegrees is always within [0, 360)", () => {
  const b = bearingDegrees({ lat: 10, lon: 10 }, { lat: 5, lon: 5 });
  assert.ok(b >= 0 && b < 360);
});
