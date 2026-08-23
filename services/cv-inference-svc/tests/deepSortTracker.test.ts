import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepSortTracker, type RawDetection } from "../src/tracker/deepSortTracker.js";

function detectionAt(cx: number, cy: number, classification = "GroundVehicle.Tracked"): RawDetection {
  return { bbox: { cx, cy, w: 10, h: 10 }, classification, confidence: 0.9 };
}

test("a detection in frame 1 becomes a confirmed track by frame 2", () => {
  const tracker = new DeepSortTracker();
  const first = tracker.step([detectionAt(100, 100)]);
  assert.equal(first.length, 1);
  const trackId = first[0]!.trackId;

  const second = tracker.step([detectionAt(103, 100)]);
  assert.equal(second.length, 1);
  assert.equal(second[0]!.trackId, trackId, "the same object across frames must keep the same track ID");
});

test("REQ-2.4: a track survives occlusion (missed frames) up to maxMissedFrames", () => {
  const tracker = new DeepSortTracker({ maxMissedFrames: 5 });
  const first = tracker.step([detectionAt(100, 100)]);
  const trackId = first[0]!.trackId;

  // 5 frames with no matching detection — the track must still be alive.
  for (let i = 0; i < 5; i++) {
    const result = tracker.step([]);
    assert.equal(result.length, 1, `track should survive missed frame ${i + 1}/5`);
    assert.equal(result[0]!.trackId, trackId);
  }

  // One more missed frame past the budget — the track must be dropped.
  const afterBudget = tracker.step([]);
  assert.equal(afterBudget.length, 0, "track should be dropped once maxMissedFrames is exceeded");
});

test("a re-appearing detection after occlusion re-matches the surviving track, not a new one", () => {
  const tracker = new DeepSortTracker({ maxMissedFrames: 10 });
  const first = tracker.step([detectionAt(100, 100)]);
  const trackId = first[0]!.trackId;

  tracker.step([]); // occluded for a couple frames
  tracker.step([]);

  // The track never got a second real update while occluded, so its
  // Kalman-estimated velocity is still 0 and it hasn't moved from (100,100)
  // — the reappearing detection needs to still overlap that same spot by
  // >= the default 0.3 IoU threshold. A 10x10 box offset by only 3px keeps
  // IoU at 70/130 ~= 0.54; the offset matters here, not just "nearby".
  const reappeared = tracker.step([detectionAt(103, 100)]);
  assert.equal(reappeared.length, 1);
  assert.equal(reappeared[0]!.trackId, trackId);
});

test("two well-separated detections in the same frame become two independent tracks", () => {
  const tracker = new DeepSortTracker();
  const result = tracker.step([detectionAt(0, 0), detectionAt(1000, 1000)]);
  assert.equal(result.length, 2);
  assert.notEqual(result[0]!.trackId, result[1]!.trackId);
});

test("ML-005: a moving track reports nonzero velocity/speed after a few frames", () => {
  // IoU-only association (no appearance embedding — see
  // trackAssociation.ts's scope note) needs consecutive-frame boxes to
  // actually overlap: a 10-wide box moving 10px/frame has already lost all
  // overlap with where it was, so no correction is possible after the
  // first step. A 3px/frame step (10-wide box) keeps IoU around 0.54 (see
  // the other test above) so association keeps succeeding while the
  // filter's velocity estimate converges toward the true ~3px/frame.
  const tracker = new DeepSortTracker();
  for (let i = 0; i <= 5; i++) {
    tracker.step([detectionAt(3 * i, 0)]);
  }
  const result = tracker.step([detectionAt(18, 0)]);
  assert.equal(result.length, 1);
  assert.ok(result[0]!.speed > 1, `expected meaningful speed after consistent motion, got ${result[0]!.speed}`);
});

test("activeTrackCount includes not-yet-confirmed tracks even when minHitsToConfirm hides them from step()'s return", () => {
  const tracker = new DeepSortTracker({ minHitsToConfirm: 3 });
  const result = tracker.step([detectionAt(0, 0)]);
  assert.equal(result.length, 0, "a single hit shouldn't be reported yet");
  assert.equal(tracker.activeTrackCount, 1, "but the tracker is still tracking it internally");
});
