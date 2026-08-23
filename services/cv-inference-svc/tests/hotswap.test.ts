// Real Fastify app (app.inject, not a live HTTP server — same pattern as
// geospatial-svc), a real multipart upload, and a real onnxruntime-node
// session swap — REQ-2.6's "upload -> validate -> hot-load ... no service
// restart" end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import FormData from "form-data";
import { buildApp } from "../src/app.js";
import { DetectionModel } from "../src/inference/session.js";

// tsc doesn't copy non-.ts assets into dist/ — import.meta.dirname here is
// dist/tests, so this walks back up to the *source* tests/fixtures/
// directory rather than a dist/tests/fixtures/ that was never populated.
const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "tests", "fixtures");
const YOLOV8N_FIXTURE = join(FIXTURES_DIR, "yolov8n.int8.onnx");
const GROUND_VEHICLE_FIXTURE = join(FIXTURES_DIR, "synthetic-groundvehicle.int8.onnx");

async function uploadFixture(app: ReturnType<typeof buildApp>, fixturePath: string, filename = "model.onnx") {
  const form = new FormData();
  form.append("file", await readFile(fixturePath), { filename });
  return app.inject({
    method: "POST",
    url: "/api/v1/models/upload",
    payload: form,
    headers: form.getHeaders(),
  });
}

test("uploading a real ONNX model hot-swaps the active session", async () => {
  const model = await DetectionModel.load(YOLOV8N_FIXTURE, { requireGpu: false });
  const app = buildApp({ model, requireGpu: false, logger: false });

  const res = await uploadFixture(app, GROUND_VEHICLE_FIXTURE);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", executionProvider: "cpu" });

  // Prove the swap actually took effect, not just that the endpoint
  // returned 200 — infer against the now-active model and check its output
  // shape matches the single-class GroundVehicle model, not the 80-class
  // one. This fixture was exported at imgsz=320 (tests/fixtures/README.md),
  // not 640 — the swapped-in model can declare its own input size.
  const dummyTensor = new Float32Array(3 * 320 * 320);
  const output = await model.infer(dummyTensor, 320);
  assert.equal(output.numClasses, 1);

  await app.close();
});

test("uploading a non-.onnx filename is rejected with 400", async () => {
  const model = await DetectionModel.load(YOLOV8N_FIXTURE, { requireGpu: false });
  const app = buildApp({ model, requireGpu: false, logger: false });

  const res = await uploadFixture(app, YOLOV8N_FIXTURE, "model.txt");
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /expected an \.onnx file/);

  await app.close();
});

test("uploading a file that isn't a valid ONNX model is rejected with 400 and the live model is untouched", async () => {
  const model = await DetectionModel.load(YOLOV8N_FIXTURE, { requireGpu: false });
  const app = buildApp({ model, requireGpu: false, logger: false });

  const form = new FormData();
  form.append("file", Buffer.from("not a real onnx file"), { filename: "bogus.onnx" });
  const res = await app.inject({ method: "POST", url: "/api/v1/models/upload", payload: form, headers: form.getHeaders() });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /model failed to load/);

  // The live model must still be the original 80-class one — a failed
  // validation must never touch the running session.
  const dummyTensor = new Float32Array(3 * 640 * 640);
  const output = await model.infer(dummyTensor, 640);
  assert.equal(output.numClasses, 80);

  await app.close();
});

test("GET /healthz reports the active execution provider", async () => {
  const model = await DetectionModel.load(YOLOV8N_FIXTURE, { requireGpu: false });
  const app = buildApp({ model, requireGpu: false, logger: false });

  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok", executionProvider: "cpu" });

  await app.close();
});
