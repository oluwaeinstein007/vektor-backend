import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeYoloOutput, type RawModelOutput } from "../src/inference/postprocess.js";
import type { PreprocessedImage } from "../src/inference/preprocess.js";

const CLASS_NAMES = ["person", "car"];

// Builds a synthetic YOLOv8-shaped output tensor: [1, 4+numClasses, numAnchors],
// flattened channel-major (all cx values, then all cy, then w, then h, then
// each class's score row) — matching what onnxruntime-node's Tensor.data
// actually returns for this model architecture.
function buildOutput(
  anchors: Array<{ cx: number; cy: number; w: number; h: number; scores: number[] }>,
): RawModelOutput {
  const numAnchors = anchors.length;
  const numClasses = CLASS_NAMES.length;
  const data = new Float32Array((4 + numClasses) * numAnchors);

  anchors.forEach((a, i) => {
    data[i] = a.cx;
    data[numAnchors + i] = a.cy;
    data[2 * numAnchors + i] = a.w;
    data[3 * numAnchors + i] = a.h;
    a.scores.forEach((score, c) => {
      data[(4 + c) * numAnchors + i] = score;
    });
  });

  return { data, numClasses, numAnchors };
}

function identityPreprocessed(): PreprocessedImage {
  // scale=1, no padding — model-space coordinates equal original-image
  // coordinates, so expected test values don't need to account for the
  // letterbox transform.
  return { tensorData: new Float32Array(0), targetSize: 640, originalWidth: 640, originalHeight: 640, scale: 1, padX: 0, padY: 0 };
}

test("decodes a single confident detection", () => {
  const output = buildOutput([{ cx: 100, cy: 100, w: 40, h: 60, scores: [0.9, 0.1] }]);
  const detections = decodeYoloOutput(output, identityPreprocessed(), CLASS_NAMES, 0.25);

  assert.equal(detections.length, 1);
  assert.equal(detections[0]!.className, "person");
  assert.ok(Math.abs(detections[0]!.confidence - 0.9) < 1e-6);
  assert.deepEqual(detections[0]!.bbox, { cx: 100, cy: 100, w: 40, h: 60 });
});

test("drops detections below the confidence threshold", () => {
  const output = buildOutput([{ cx: 100, cy: 100, w: 40, h: 60, scores: [0.1, 0.05] }]);
  const detections = decodeYoloOutput(output, identityPreprocessed(), CLASS_NAMES, 0.25);
  assert.equal(detections.length, 0);
});

test("NMS suppresses a lower-confidence duplicate of the same class at nearly the same location", () => {
  const output = buildOutput([
    { cx: 100, cy: 100, w: 40, h: 40, scores: [0.9, 0] },
    { cx: 102, cy: 100, w: 40, h: 40, scores: [0.7, 0] }, // heavy overlap, same class, lower score
  ]);
  const detections = decodeYoloOutput(output, identityPreprocessed(), CLASS_NAMES, 0.25, 0.45);
  assert.equal(detections.length, 1);
  assert.ok(Math.abs(detections[0]!.confidence - 0.9) < 1e-6, "the higher-confidence box should survive");
});

test("NMS keeps overlapping boxes of different classes", () => {
  const output = buildOutput([
    { cx: 100, cy: 100, w: 40, h: 40, scores: [0.9, 0] }, // person
    { cx: 100, cy: 100, w: 40, h: 40, scores: [0, 0.85] }, // car, same location — plausible (person in car)
  ]);
  const detections = decodeYoloOutput(output, identityPreprocessed(), CLASS_NAMES, 0.25, 0.45);
  assert.equal(detections.length, 2);
});

test("undoes the letterbox transform to map boxes back to original image coordinates", () => {
  // A 1280x720 source letterboxed into a 640x640 model input: scale=0.5,
  // padX=0, padY=160 (matches preprocess.ts's contain-fit math).
  const preprocessed: PreprocessedImage = {
    tensorData: new Float32Array(0),
    targetSize: 640,
    originalWidth: 1280,
    originalHeight: 720,
    scale: 0.5,
    padX: 0,
    padY: 160,
  };
  // A detection at model-space (320, 320) with size 100x100.
  const output = buildOutput([{ cx: 320, cy: 320, w: 100, h: 100, scores: [0.9, 0] }]);
  const detections = decodeYoloOutput(output, preprocessed, CLASS_NAMES, 0.25);

  assert.equal(detections.length, 1);
  const { bbox } = detections[0]!;
  assert.ok(Math.abs(bbox.cx - 640) < 1e-6, `expected cx=640, got ${bbox.cx}`); // (320-0)/0.5
  assert.ok(Math.abs(bbox.cy - 320) < 1e-6, `expected cy=320, got ${bbox.cy}`); // (320-160)/0.5
  assert.ok(Math.abs(bbox.w - 200) < 1e-6);
  assert.ok(Math.abs(bbox.h - 200) < 1e-6);
});
