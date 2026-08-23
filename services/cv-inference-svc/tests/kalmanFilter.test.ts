import { test } from "node:test";
import assert from "node:assert/strict";
import { KalmanFilter } from "../src/tracker/kalmanFilter.js";

test("tracks a stationary object: predict+update converges to the true position", () => {
  const kf = new KalmanFilter({ cx: 100, cy: 100, w: 20, h: 20 });
  for (let i = 0; i < 10; i++) {
    kf.predict();
    kf.update({ cx: 100, cy: 100, w: 20, h: 20 });
  }
  const bbox = kf.bbox;
  assert.ok(Math.abs(bbox.cx - 100) < 1);
  assert.ok(Math.abs(bbox.cy - 100) < 1);
  assert.ok(Math.abs(kf.speed) < 1, "a stationary object should have ~zero estimated speed");
});

test("tracks a linearly moving object and recovers its velocity", () => {
  const kf = new KalmanFilter({ cx: 0, cy: 0, w: 20, h: 20 });
  // Moves +5px/frame in x, 0 in y — a real (if idealized) constant-velocity
  // sequence, not a single snapshot, since a Kalman filter's velocity
  // state only becomes meaningful after it's seen the object actually move.
  for (let i = 1; i <= 20; i++) {
    kf.predict();
    kf.update({ cx: 5 * i, cy: 0, w: 20, h: 20 });
  }
  const { vx, vy } = kf.velocity;
  assert.ok(Math.abs(vx - 5) < 0.5, `expected vx ~5, got ${vx}`);
  assert.ok(Math.abs(vy) < 0.5, `expected vy ~0, got ${vy}`);
});

test("predict() alone (no update) coasts the state forward using the last known velocity", () => {
  const kf = new KalmanFilter({ cx: 0, cy: 0, w: 20, h: 20 });
  for (let i = 1; i <= 10; i++) {
    kf.predict();
    kf.update({ cx: 10 * i, cy: 0, w: 20, h: 20 });
  }
  const beforeCoast = kf.bbox.cx;
  kf.predict(); // occlusion: no matching detection this frame
  assert.ok(kf.bbox.cx > beforeCoast, "coasting on velocity alone should still advance position");
});

test("headingDeg reports 0 for a stationary object and a sane direction for motion", () => {
  const stationary = new KalmanFilter({ cx: 0, cy: 0, w: 10, h: 10 });
  assert.equal(stationary.headingDeg, 0);

  // Moving in +x (rightward) only.
  const moving = new KalmanFilter({ cx: 0, cy: 0, w: 10, h: 10 });
  for (let i = 1; i <= 10; i++) {
    moving.predict();
    moving.update({ cx: 10 * i, cy: 0, w: 10, h: 10 });
  }
  assert.ok(moving.headingDeg >= 0 && moving.headingDeg < 360);
  assert.ok(Math.abs(moving.headingDeg - 90) < 5, `expected ~90deg for rightward motion, got ${moving.headingDeg}`);
});
