// SVC-015 — REQ-5.2: "Detect behavioral anomalies (speed/heading/formation
// deviation) via statistical time-series analysis." Formation deviation is
// out of scope here (no multi-entity grouping model exists anywhere in the
// project yet) — this covers speed and heading, per entity, with an
// incremental EWMA mean + EWMA variance (a standard streaming
// approximation, not a full statistical model — same "genuine but scoped"
// tradeoff as cv-inference-svc's greedy-IoU DeepSORT tracker instead of the
// Hungarian algorithm).
//
// Heading is circular (0 and 360 are the same direction) — a naive z-score
// on the raw degree value breaks at the wraparound boundary (359 -> 1 looks
// like a 358-degree jump). Fix: EWMA the unit vector (sin, cos) instead of
// the angle, then measure the *angular deviation* of the new heading from
// that smoothed direction (always in [-180, 180], no wraparound) and
// z-score that deviation against its own EWMA variance.
const DEFAULT_ALPHA = 0.3;
const MIN_STD = 1e-6; // avoid a divide-by-zero z-score on a detector's very first few samples

interface EwmaState {
  mean: number;
  variance: number;
  initialized: boolean;
}

function updateEwma(state: EwmaState, value: number, alpha: number): number {
  if (!state.initialized) {
    state.mean = value;
    state.variance = 0;
    state.initialized = true;
    return 0;
  }
  // The z-score has to be measured against the baseline as it stood
  // *before* this sample — computing it from the post-update variance
  // would let a genuine spike inflate its own denominator (the spike's
  // squared deviation gets folded into state.variance below), diluting the
  // very z-score meant to catch it.
  const deviation = value - state.mean;
  const stdBefore = Math.sqrt(state.variance);
  const zScore = deviation / Math.max(stdBefore, MIN_STD);
  state.mean = alpha * value + (1 - alpha) * state.mean;
  state.variance = alpha * deviation * deviation + (1 - alpha) * state.variance;
  return zScore;
}

function angularDeviationDeg(from: number, to: number): number {
  let diff = (to - from) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

interface EntityAnomalyState {
  speed: EwmaState;
  headingSin: EwmaState;
  headingCos: EwmaState;
  headingDeviation: EwmaState;
}

export interface AnomalyResult {
  speedZScore: number;
  headingZScore: number;
  isAnomalous: boolean;
}

export interface EwmaDetectorOptions {
  alpha?: number;
  zScoreThreshold?: number;
}

/**
 * One instance per alert-svc process, keyed by entity_id — in-memory only
 * (not persisted to Redis/Postgres), so a restart resets every entity's
 * baseline. Acceptable for this scope: the same tradeoff cv-inference-svc's
 * DeepSORT tracker already makes for track state.
 */
export class EwmaAnomalyDetector {
  private readonly states = new Map<string, EntityAnomalyState>();
  private readonly alpha: number;
  private readonly zScoreThreshold: number;

  constructor(options: EwmaDetectorOptions = {}) {
    this.alpha = options.alpha ?? DEFAULT_ALPHA;
    this.zScoreThreshold = options.zScoreThreshold ?? 3;
  }

  update(entityId: string, speedKmh: number, headingDeg: number): AnomalyResult {
    let state = this.states.get(entityId);
    if (!state) {
      state = {
        speed: { mean: 0, variance: 0, initialized: false },
        headingSin: { mean: 0, variance: 0, initialized: false },
        headingCos: { mean: 0, variance: 0, initialized: false },
        headingDeviation: { mean: 0, variance: 0, initialized: false },
      };
      this.states.set(entityId, state);
    }

    const speedZScore = updateEwma(state.speed, speedKmh, this.alpha);

    const rad = (headingDeg * Math.PI) / 180;
    updateEwma(state.headingSin, Math.sin(rad), this.alpha);
    updateEwma(state.headingCos, Math.cos(rad), this.alpha);
    const smoothedHeadingDeg = (Math.atan2(state.headingSin.mean, state.headingCos.mean) * 180) / Math.PI;
    const deviation = angularDeviationDeg(smoothedHeadingDeg, headingDeg);
    const headingZScore = updateEwma(state.headingDeviation, deviation, this.alpha);

    const isAnomalous = Math.abs(speedZScore) > this.zScoreThreshold || Math.abs(headingZScore) > this.zScoreThreshold;
    return { speedZScore, headingZScore, isAnomalous };
  }

  reset(entityId: string): void {
    this.states.delete(entityId);
  }
}
