import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastDepletion, isLowStock } from "../src/forecast/regression.js";

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3_600_000);
}

test("forecastDepletion: fewer than 2 points yields zero rate, no projection", () => {
  const result = forecastDepletion([{ ts: new Date(), quantity: 100 }]);
  assert.equal(result.depletion_rate_per_hour, 0);
  assert.equal(result.hours_to_stockout, null);
});

test("forecastDepletion: a steady linear decline projects a sensible time-to-stockout", () => {
  // 100 units 10h ago, declining 5 units/hour, 50 units now
  const history = [
    { ts: hoursAgo(10), quantity: 100 },
    { ts: hoursAgo(8), quantity: 90 },
    { ts: hoursAgo(6), quantity: 80 },
    { ts: hoursAgo(4), quantity: 70 },
    { ts: hoursAgo(2), quantity: 60 },
    { ts: hoursAgo(0), quantity: 50 },
  ];
  const result = forecastDepletion(history);
  assert.ok(Math.abs(result.depletion_rate_per_hour - 5) < 0.1, `expected ~5/hr, got ${result.depletion_rate_per_hour}`);
  assert.ok(result.hours_to_stockout !== null);
  assert.ok(Math.abs(result.hours_to_stockout! - 10) < 0.5, `expected ~10h to stockout, got ${result.hours_to_stockout}`);
});

test("forecastDepletion: replenishing stock (positive slope) has no stockout projection", () => {
  const history = [
    { ts: hoursAgo(4), quantity: 50 },
    { ts: hoursAgo(2), quantity: 70 },
    { ts: hoursAgo(0), quantity: 90 },
  ];
  const result = forecastDepletion(history);
  assert.ok(result.depletion_rate_per_hour < 0); // negative = replenishing
  assert.equal(result.hours_to_stockout, null);
});

test("forecastDepletion: flat stock (no change) has ~zero rate and no stockout", () => {
  const history = [
    { ts: hoursAgo(4), quantity: 100 },
    { ts: hoursAgo(2), quantity: 100 },
    { ts: hoursAgo(0), quantity: 100 },
  ];
  const result = forecastDepletion(history);
  assert.ok(Math.abs(result.depletion_rate_per_hour) < 0.01);
  assert.equal(result.hours_to_stockout, null);
});

test("isLowStock: below reorder threshold is always low-stock regardless of forecast", () => {
  assert.equal(isLowStock(5, 10, null, 24), true);
});

test("isLowStock: above threshold but projected to run out within lead time IS low-stock", () => {
  assert.equal(isLowStock(50, 10, 12, 24), true); // 12h to stockout, 24h lead time
});

test("isLowStock: above threshold and projected stockout beyond lead time is NOT low-stock", () => {
  assert.equal(isLowStock(50, 10, 100, 24), false);
});

test("isLowStock: above threshold with no decline projection is NOT low-stock", () => {
  assert.equal(isLowStock(50, 10, null, 24), false);
});
