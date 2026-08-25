// ML-011 — real end-to-end verification of the edge COA path: an actual
// node-llama-cpp model, loaded from a real GGUF file, generating a real
// completion that gets parsed against the COAOption schema. The production
// target is Mistral 7B Q4_K_M (§10.3); this uses a much smaller real model
// (Qwen2.5-0.5B-Instruct, Q4_K_M) as the test fixture for the same reason
// cv-inference-svc's tests use small ONNX fixtures instead of full YOLOv8
// weights — this verifies the real node-llama-cpp/parsing/dispose
// mechanics, not production-scale output quality.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCoaEdge } from "../src/llm/edgeClient.js";

// dist/tests -> walk back to the source tree's tests/fixtures, same pitfall
// as cv-inference-svc's compiled-fixture-path handling (see
// vektor-build-conventions).
const MODEL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "fixtures",
  "qwen2.5-0.5b-instruct-q4_k_m.gguf",
);

const SITUATION_JSON = JSON.stringify({
  target: {
    entity: {
      entity_id: "11111111-1111-1111-1111-111111111111",
      classification: "GroundVehicle.Tracked",
      affiliation: "HOSTILE",
    },
    threat_score: 0.8,
  },
  blue_force_assets: [{ callsign: "OUTPOST-1" }],
  no_strike_zones: [],
});

test(
  "generateCoaEdge produces a real, schema-valid COA from an actual local GGUF model",
  { skip: !existsSync(MODEL_PATH) && "fixture model not downloaded — see tests/fixtures/README.md" },
  async () => {
    const result = await generateCoaEdge({
      modelPath: MODEL_PATH,
      situationJson: SITUATION_JSON,
      doctrineContext: "HOSTILE entities may be targeted; FRIENDLY entities and no-strike zones must never be targeted.",
      numOptions: 1,
    });

    assert.ok(result.options.length >= 1);
    const option = result.options[0]!;
    assert.equal(typeof option.title, "string");
    assert.ok(option.title.length > 0);
    assert.ok(option.confidence >= 0 && option.confidence <= 1);
    assert.ok(Array.isArray(option.required_assets));
    assert.ok(Array.isArray(option.context_factors));
  },
);
