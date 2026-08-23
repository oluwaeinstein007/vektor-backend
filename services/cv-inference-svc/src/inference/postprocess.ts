// ML-002: decodes a YOLOv8 ONNX output tensor (shape [1, 4+numClasses,
// numAnchors] — box coords then per-class scores, per anchor) into
// image-space detections, undoing preprocess.ts's letterbox transform and
// running per-class NMS. Reuses tracker/trackAssociation.ts's `iou` rather
// than a second IoU implementation.
import type { BBox } from "../tracker/kalmanFilter.js";
import { iou } from "../tracker/trackAssociation.js";
import type { PreprocessedImage } from "./preprocess.js";

export interface RawModelOutput {
  data: Float32Array;
  numClasses: number;
  numAnchors: number;
}

export interface Detection {
  bbox: BBox; // original frame pixel coordinates
  classIndex: number;
  className: string;
  confidence: number;
}

export function decodeYoloOutput(
  output: RawModelOutput,
  preprocessed: PreprocessedImage,
  classNames: string[],
  confidenceThreshold = 0.25,
  nmsIouThreshold = 0.45,
): Detection[] {
  const { data, numClasses, numAnchors } = output;
  const candidates: Detection[] = [];

  for (let a = 0; a < numAnchors; a++) {
    let bestClassIndex = -1;
    let bestScore = 0;
    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numAnchors + a]!;
      if (score > bestScore) {
        bestScore = score;
        bestClassIndex = c;
      }
    }
    if (bestClassIndex === -1 || bestScore < confidenceThreshold) continue;

    const modelCx = data[a]!;
    const modelCy = data[numAnchors + a]!;
    const modelW = data[2 * numAnchors + a]!;
    const modelH = data[3 * numAnchors + a]!;

    // Undo preprocess.ts's letterbox transform: model-input-space -> original frame space.
    const cx = (modelCx - preprocessed.padX) / preprocessed.scale;
    const cy = (modelCy - preprocessed.padY) / preprocessed.scale;
    const w = modelW / preprocessed.scale;
    const h = modelH / preprocessed.scale;

    candidates.push({
      bbox: { cx, cy, w, h },
      classIndex: bestClassIndex,
      className: classNames[bestClassIndex] ?? `class_${bestClassIndex}`,
      confidence: bestScore,
    });
  }

  return nonMaxSuppression(candidates, nmsIouThreshold);
}

function nonMaxSuppression(detections: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];

  for (const candidate of sorted) {
    const overlapsKept = kept.some(
      (k) => k.classIndex === candidate.classIndex && iou(k.bbox, candidate.bbox) > iouThreshold,
    );
    if (!overlapsKept) kept.push(candidate);
  }

  return kept;
}
