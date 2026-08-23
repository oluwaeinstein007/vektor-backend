import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtendedKalmanFilter } from "../src/ekf/extendedKalmanFilter.js";

test("predict() advances position along a constant northward velocity", () => {
  const ekf = new ExtendedKalmanFilter({ lat: 0, lon: 0, alt_m: 0 });
  // Seed a velocity by updating twice 1s apart with a fix that moved ~10m north.
  ekf.update({ lat: 0, lon: 0, alt_m: 0 });
  ekf.predict(1);
  ekf.update({ lat: 10 / 111_320, lon: 0, alt_m: 0 });

  const before = ekf.position;
  ekf.predict(1);
  const after = ekf.position;

  assert.ok(after.lat > before.lat, "latitude should increase moving north");
  assert.ok(Math.abs(after.lon - before.lon) < 1e-9, "longitude should not drift from a purely northward velocity");
});

test("update() pulls the predicted state toward a new measurement", () => {
  const ekf = new ExtendedKalmanFilter({ lat: 10, lon: 20, alt_m: 100 });
  ekf.predict(1);
  const beforeUpdate = ekf.position;

  ekf.update({ lat: 10.01, lon: 20.01, alt_m: 150 });
  const afterUpdate = ekf.position;

  assert.ok(
    Math.abs(afterUpdate.lat - 10.01) < Math.abs(beforeUpdate.lat - 10.01),
    "update should move the estimate closer to the new fix than the prediction was",
  );
});

test("heading/speed converge to the true track under repeated eastward fixes (nonlinear longitude scaling)", () => {
  // At 45N, a degree of longitude covers noticeably fewer meters than a
  // degree of latitude — this is exactly the Jacobian coupling the EKF
  // exists to handle. A track moving due east at a constant speed should
  // still converge to headingDeg ~90 and the correct speedKmh.
  const startLat = 45;
  const speedMps = 20; // ~72 km/h
  const dt = 1;
  const metersPerDegLonAt45 = 111_320 * Math.cos((startLat * Math.PI) / 180);

  const ekf = new ExtendedKalmanFilter({ lat: startLat, lon: 0, alt_m: 0 });
  let lon = 0;
  for (let step = 0; step < 50; step++) {
    ekf.predict(dt);
    lon += (speedMps * dt) / metersPerDegLonAt45;
    ekf.update({ lat: startLat, lon, alt_m: 0 });
  }

  assert.ok(Math.abs(ekf.headingDeg - 90) < 2, `expected heading ~90 (east), got ${ekf.headingDeg}`);
  assert.ok(Math.abs(ekf.speedKmh - speedMps * 3.6) < 2, `expected speed ~${speedMps * 3.6}km/h, got ${ekf.speedKmh}`);
});

test("accuracyM shrinks as repeated consistent measurements reduce uncertainty", () => {
  const ekf = new ExtendedKalmanFilter({ lat: 0, lon: 0, alt_m: 0 });
  const initialAccuracy = ekf.accuracyM;

  for (let i = 0; i < 10; i++) {
    ekf.predict(1);
    ekf.update({ lat: 0, lon: 0, alt_m: 0 });
  }

  assert.ok(ekf.accuracyM < initialAccuracy, "repeated consistent fixes should reduce position uncertainty");
});
