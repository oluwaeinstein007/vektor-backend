import { test } from "node:test";
import assert from "node:assert/strict";
import { EwmaAnomalyDetector } from "../src/anomaly/ewmaDetector.js";
import { randomUUID } from "node:crypto";

test("EwmaAnomalyDetector: steady speed/heading never trips the threshold", () => {
  const detector = new EwmaAnomalyDetector();
  const entityId = randomUUID();
  let lastResult;
  for (let i = 0; i < 30; i++) {
    // small jitter around 50 km/h, 90 degrees — realistic sensor noise, not a real deviation
    lastResult = detector.update(entityId, 50 + (i % 2 === 0 ? 0.5 : -0.5), 90 + (i % 2 === 0 ? 1 : -1));
  }
  assert.equal(lastResult!.isAnomalous, false);
});

test("EwmaAnomalyDetector: a sudden speed spike trips the threshold", () => {
  const detector = new EwmaAnomalyDetector();
  const entityId = randomUUID();
  for (let i = 0; i < 20; i++) {
    detector.update(entityId, 50, 90);
  }
  const result = detector.update(entityId, 400, 90); // sudden 8x speed jump
  assert.equal(result.isAnomalous, true);
  assert.ok(Math.abs(result.speedZScore) > 3);
});

test("EwmaAnomalyDetector: heading wraparound (359 -> 1 degrees) is NOT flagged as anomalous", () => {
  const detector = new EwmaAnomalyDetector();
  const entityId = randomUUID();
  // an entity steadily heading due north, oscillating across the 360/0 boundary
  const headings = [358, 359, 360 % 360, 1, 2, 1, 359, 0, 1];
  let lastResult;
  for (const h of headings) {
    for (let i = 0; i < 4; i++) lastResult = detector.update(entityId, 50, h); // repeat to let EWMA settle per value
  }
  assert.equal(lastResult!.isAnomalous, false);
});

test("EwmaAnomalyDetector: a genuine sharp heading reversal (90 -> 270) IS flagged", () => {
  const detector = new EwmaAnomalyDetector();
  const entityId = randomUUID();
  for (let i = 0; i < 20; i++) detector.update(entityId, 50, 90);
  const result = detector.update(entityId, 50, 270); // 180-degree reversal
  assert.equal(result.isAnomalous, true);
  assert.ok(Math.abs(result.headingZScore) > 3);
});

test("EwmaAnomalyDetector: state is tracked independently per entity", () => {
  const detector = new EwmaAnomalyDetector();
  const a = randomUUID();
  const b = randomUUID();
  for (let i = 0; i < 20; i++) detector.update(a, 20, 45);
  for (let i = 0; i < 20; i++) detector.update(b, 200, 45); // a fast entity, unrelated to `a`
  // `b`'s established baseline (200 km/h) means one more sample at 200 is NOT anomalous for b
  const result = detector.update(b, 200, 45);
  assert.equal(result.isAnomalous, false);
});
