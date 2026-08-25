import { test } from "node:test";
import assert from "node:assert/strict";
import { isDue } from "../src/schedule/scheduler.js";

test("isDue: a never-run schedule is due immediately", () => {
  assert.equal(isDue("*/5 * * * *", null, new Date()), true);
});

test("isDue: an every-5-minutes schedule that ran 1 minute ago is NOT yet due", () => {
  const now = new Date("2026-01-01T00:06:00Z");
  const lastRun = new Date("2026-01-01T00:05:00Z"); // ran right at the 00:05 tick
  assert.equal(isDue("*/5 * * * *", lastRun, now), false);
});

test("isDue: an every-5-minutes schedule that ran 6 minutes ago IS due", () => {
  const now = new Date("2026-01-01T00:11:00Z");
  const lastRun = new Date("2026-01-01T00:05:00Z");
  assert.equal(isDue("*/5 * * * *", lastRun, now), true);
});

test("isDue: a daily-at-midnight schedule that ran earlier today is not due again until tomorrow", () => {
  const lastRun = new Date("2026-01-01T00:00:30Z"); // just after today's midnight fire
  const laterSameDay = new Date("2026-01-01T18:00:00Z");
  assert.equal(isDue("0 0 * * *", lastRun, laterSameDay), false);

  const nextDay = new Date("2026-01-02T00:00:05Z");
  assert.equal(isDue("0 0 * * *", lastRun, nextDay), true);
});
