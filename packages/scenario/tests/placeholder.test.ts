// Placeholder so `pnpm test` has something to run in this package while the
// engine is being written. Replace with the determinism tests — same
// scenario plus same seed producing byte-identical output is the property
// that makes this a test harness rather than a demo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIO_DEFAULT_ENV } from "../src/index.js";

test("defaults to an isolated topic namespace, not dev", () => {
  assert.equal(SCENARIO_DEFAULT_ENV, "sim");
  assert.notEqual(SCENARIO_DEFAULT_ENV, "dev");
});
