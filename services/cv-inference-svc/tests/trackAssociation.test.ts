import { test } from "node:test";
import assert from "node:assert/strict";
import { iou, associate } from "../src/tracker/trackAssociation.js";
import type { BBox } from "../src/tracker/kalmanFilter.js";

test("iou is 1.0 for identical boxes", () => {
  const box: BBox = { cx: 10, cy: 10, w: 4, h: 4 };
  assert.equal(iou(box, box), 1);
});

test("iou is 0 for non-overlapping boxes", () => {
  const a: BBox = { cx: 0, cy: 0, w: 2, h: 2 };
  const b: BBox = { cx: 100, cy: 100, w: 2, h: 2 };
  assert.equal(iou(a, b), 0);
});

test("iou is 0.5 for a known half-overlap case", () => {
  // a: [0,0]-[2,2] (area 4). b: [1,0]-[3,2] (area 4). intersection: [1,0]-[2,2] = area 2.
  // union = 4 + 4 - 2 = 6. iou = 2/6 = 1/3.
  const a: BBox = { cx: 1, cy: 1, w: 2, h: 2 };
  const b: BBox = { cx: 2, cy: 1, w: 2, h: 2 };
  assert.ok(Math.abs(iou(a, b) - 1 / 3) < 1e-9);
});

test("associate matches the single obvious pair", () => {
  const tracks: BBox[] = [{ cx: 10, cy: 10, w: 4, h: 4 }];
  const detections: BBox[] = [{ cx: 10.5, cy: 10, w: 4, h: 4 }];
  const result = associate(tracks, detections, 0.3);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.trackIndex, 0);
  assert.equal(result.matches[0]!.detectionIndex, 0);
  assert.deepEqual(result.unmatchedTracks, []);
  assert.deepEqual(result.unmatchedDetections, []);
});

test("associate leaves a detection unmatched when no track is close enough", () => {
  const tracks: BBox[] = [{ cx: 10, cy: 10, w: 4, h: 4 }];
  const detections: BBox[] = [{ cx: 1000, cy: 1000, w: 4, h: 4 }];
  const result = associate(tracks, detections, 0.3);
  assert.equal(result.matches.length, 0);
  assert.deepEqual(result.unmatchedTracks, [0]);
  assert.deepEqual(result.unmatchedDetections, [0]);
});

test("associate prefers the higher-IoU pairing when a detection is ambiguous between two tracks", () => {
  const tracks: BBox[] = [
    { cx: 10, cy: 10, w: 4, h: 4 }, // track 0
    { cx: 10, cy: 12, w: 4, h: 4 }, // track 1 — slightly further from the detection below
  ];
  const detections: BBox[] = [{ cx: 10, cy: 10, w: 4, h: 4 }]; // exactly matches track 0
  const result = associate(tracks, detections, 0.1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.trackIndex, 0, "the exact-overlap track should win, not the merely-nearby one");
  assert.deepEqual(result.unmatchedTracks, [1]);
});
