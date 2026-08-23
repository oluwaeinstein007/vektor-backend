// ML-004: orchestrates the per-frame tracking loop — predict every active
// track, associate against this frame's detections, update matched tracks,
// age out unmatched ones, and start new tracks for anything left over.
// REQ-2.4: persistent track IDs across frames, surviving occlusion.
import { randomUUID } from "node:crypto";
import { KalmanFilter, type BBox, type Velocity } from "./kalmanFilter.js";
import { associate } from "./trackAssociation.js";

export interface RawDetection {
  bbox: BBox;
  classification: string;
  confidence: number;
}

export interface TrackedObject {
  trackId: string;
  bbox: BBox;
  velocity: Velocity;
  headingDeg: number;
  speed: number;
  classification: string;
  confidence: number;
  framesSinceUpdate: number;
  age: number;
}

interface Track {
  id: string;
  filter: KalmanFilter;
  classification: string;
  confidence: number;
  framesSinceUpdate: number;
  age: number;
  hits: number;
}

export interface DeepSortTrackerOptions {
  iouThreshold?: number;
  // REQ-2.4: "occlusion up to 10s" — expressed in frames, since the
  // tracker operates per-processed-frame, not wall-clock time. Convert
  // your pipeline's frame rate to a frame count (e.g. 15fps * 10s = 150).
  maxMissedFrames?: number;
  // A track isn't reported until it's matched this many consecutive
  // frames — suppresses single-frame false-positive "tracks".
  minHitsToConfirm?: number;
}

export class DeepSortTracker {
  private tracks: Track[] = [];
  private readonly iouThreshold: number;
  private readonly maxMissedFrames: number;
  private readonly minHitsToConfirm: number;

  constructor(options: DeepSortTrackerOptions = {}) {
    this.iouThreshold = options.iouThreshold ?? 0.3;
    this.maxMissedFrames = options.maxMissedFrames ?? 150;
    this.minHitsToConfirm = options.minHitsToConfirm ?? 1;
  }

  step(detections: RawDetection[]): TrackedObject[] {
    for (const track of this.tracks) track.filter.predict();

    const trackBoxes = this.tracks.map((t) => t.filter.bbox);
    const detectionBoxes = detections.map((d) => d.bbox);
    const { matches, unmatchedTracks, unmatchedDetections } = associate(
      trackBoxes,
      detectionBoxes,
      this.iouThreshold,
    );

    for (const { trackIndex, detectionIndex } of matches) {
      const track = this.tracks[trackIndex]!;
      const detection = detections[detectionIndex]!;
      track.filter.update(detection.bbox);
      track.classification = detection.classification;
      track.confidence = detection.confidence;
      track.framesSinceUpdate = 0;
      track.hits += 1;
      track.age += 1;
    }

    for (const trackIndex of unmatchedTracks) {
      const track = this.tracks[trackIndex]!;
      track.framesSinceUpdate += 1;
      track.age += 1;
    }

    for (const detectionIndex of unmatchedDetections) {
      const detection = detections[detectionIndex]!;
      this.tracks.push({
        id: randomUUID(),
        filter: new KalmanFilter(detection.bbox),
        classification: detection.classification,
        confidence: detection.confidence,
        framesSinceUpdate: 0,
        age: 1,
        hits: 1,
      });
    }

    this.tracks = this.tracks.filter((t) => t.framesSinceUpdate <= this.maxMissedFrames);

    return this.tracks
      .filter((t) => t.hits >= this.minHitsToConfirm)
      .map((t) => ({
        trackId: t.id,
        bbox: t.filter.bbox,
        velocity: t.filter.velocity,
        headingDeg: t.filter.headingDeg,
        speed: t.filter.speed,
        classification: t.classification,
        confidence: t.confidence,
        framesSinceUpdate: t.framesSinceUpdate,
        age: t.age,
      }));
  }

  get activeTrackCount(): number {
    return this.tracks.length;
  }
}
