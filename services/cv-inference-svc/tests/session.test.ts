// Real onnxruntime-node inference against the real checked-in YOLOv8n INT8
// model (tests/fixtures/README.md explains why it's checked in rather than
// generated) and a real ffmpeg-generated JPEG frame — not a hand-built
// tensor, so preprocess.ts's actual JPEG decode path is exercised too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { DetectionModel } from "../src/inference/session.js";
import { preprocessFrame } from "../src/inference/preprocess.js";
import { decodeYoloOutput } from "../src/inference/postprocess.js";
import { COCO_CLASS_NAMES } from "../src/cocoClasses.js";

const run = promisify(execFile);
// tsc doesn't copy non-.ts assets into dist/ — import.meta.dirname here is
// dist/tests, so this walks back up to the *source* tests/fixtures/
// directory rather than a dist/tests/fixtures/ that was never populated.
const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "tests", "fixtures");
const FIXTURE_PATH = join(FIXTURES_DIR, "yolov8n.int8.onnx");

async function generateTestFrame(): Promise<Buffer> {
  const { stdout } = await run(
    "ffmpeg",
    ["-f", "lavfi", "-i", "testsrc=size=640x480", "-frames:v", "1", "-f", "mjpeg", "-"],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout as unknown as Buffer;
}

test("DetectionModel loads the real fixture and runs real inference end-to-end", async () => {
  const model = await DetectionModel.load(FIXTURE_PATH, { requireGpu: false });
  assert.equal(model.executionProvider, "cpu");

  const frame = await generateTestFrame();
  const preprocessed = await preprocessFrame(frame, 640);
  assert.equal(preprocessed.tensorData.length, 3 * 640 * 640);

  const output = await model.infer(preprocessed.tensorData, preprocessed.targetSize);
  assert.equal(output.numClasses, 80, "yolov8n.pt was trained on the 80-class COCO set");
  assert.ok(output.numAnchors > 0);
  assert.equal(output.data.length, (4 + output.numClasses) * output.numAnchors);

  // The real, load-bearing assertion: postprocess.ts can decode this
  // model's actual output shape without throwing, regardless of whether
  // the synthetic test-pattern frame contains anything COCO-recognizable
  // (it doesn't, so an empty detection list is a perfectly valid outcome).
  const detections = decodeYoloOutput(output, preprocessed, COCO_CLASS_NAMES);
  for (const d of detections) {
    assert.ok(COCO_CLASS_NAMES.includes(d.className));
    assert.ok(d.confidence >= 0.25 && d.confidence <= 1);
  }
});

test("swap() replaces the active session and subsequent infer() calls use it", async () => {
  const model = await DetectionModel.load(FIXTURE_PATH, { requireGpu: false });
  const frame = await generateTestFrame();
  const preprocessed = await preprocessFrame(frame, 640);

  const before = await model.infer(preprocessed.tensorData, preprocessed.targetSize);
  assert.equal(before.numClasses, 80);

  const groundVehicleFixture = join(FIXTURES_DIR, "synthetic-groundvehicle.int8.onnx");
  await model.swap(groundVehicleFixture);

  // This fixture was trained/exported at imgsz=320 (tests/fixtures/README.md),
  // not yolov8n.pt's 640 — a hot-swapped model can declare a different
  // input size, so the caller has to re-preprocess for it, not reuse the
  // previous model's tensor.
  const preprocessed320 = await preprocessFrame(frame, 320);
  const after = await model.infer(preprocessed320.tensorData, preprocessed320.targetSize);
  assert.equal(after.numClasses, 1, "the swapped-in model was trained on a single GroundVehicle class");
});

test("requireGpu:true refuses to silently fall back to CPU (Pitfall 5)", async () => {
  await assert.rejects(
    () => DetectionModel.load(FIXTURE_PATH, { requireGpu: true }),
    /GPU execution provider \(CUDA\) is required but unavailable/,
  );
});
