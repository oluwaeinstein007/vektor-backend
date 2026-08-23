import type { BBox } from "./kalmanFilter.js";

export function iou(a: BBox, b: BBox): number {
  const ax1 = a.cx - a.w / 2;
  const ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2;
  const ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2;
  const by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2;
  const by2 = b.cy + b.h / 2;

  const interW = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const interH = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const interArea = interW * interH;

  const unionArea = a.w * a.h + b.w * b.h - interArea;
  return unionArea <= 0 ? 0 : interArea / unionArea;
}

export interface Association {
  trackIndex: number;
  detectionIndex: number;
  iou: number;
}

export interface AssociationResult {
  matches: Association[];
  unmatchedTracks: number[];
  unmatchedDetections: number[];
}

/**
 * Greedy IoU-based association: repeatedly picks the highest-IoU
 * (track, detection) pair above `iouThreshold`, removes both from further
 * consideration, and repeats. A simpler approximation of the Hungarian
 * algorithm DeepSORT normally uses for globally-optimal assignment — greedy
 * matching can occasionally pick a locally-optimal pairing a global solver
 * wouldn't, but it's a well-established, much simpler approach for this
 * class of problem, and avoids re-implementing the Hungarian algorithm from
 * scratch for a TS port whose main goal is correct persistent track IDs.
 */
export function associate(trackBoxes: BBox[], detectionBoxes: BBox[], iouThreshold = 0.3): AssociationResult {
  const candidates: Association[] = [];
  for (let t = 0; t < trackBoxes.length; t++) {
    for (let d = 0; d < detectionBoxes.length; d++) {
      const score = iou(trackBoxes[t]!, detectionBoxes[d]!);
      if (score >= iouThreshold) candidates.push({ trackIndex: t, detectionIndex: d, iou: score });
    }
  }
  candidates.sort((a, b) => b.iou - a.iou);

  const matchedTracks = new Set<number>();
  const matchedDetections = new Set<number>();
  const matches: Association[] = [];

  for (const candidate of candidates) {
    if (matchedTracks.has(candidate.trackIndex) || matchedDetections.has(candidate.detectionIndex)) continue;
    matches.push(candidate);
    matchedTracks.add(candidate.trackIndex);
    matchedDetections.add(candidate.detectionIndex);
  }

  return {
    matches,
    unmatchedTracks: trackBoxes.map((_, i) => i).filter((i) => !matchedTracks.has(i)),
    unmatchedDetections: detectionBoxes.map((_, i) => i).filter((i) => !matchedDetections.has(i)),
  };
}
