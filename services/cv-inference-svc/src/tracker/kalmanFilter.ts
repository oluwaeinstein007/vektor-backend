// ML-004/ML-005: a TypeScript re-implementation of DeepSORT's Kalman
// filter — VEKTOR-PRD.md §10.3 ("Custom DeepSORT implementation ...
// re-implemented using mathjs for linear algebra").
//
// 8D state: [cx, cy, w, h, vx, vy, vw, vh] — bbox center, size, and their
// per-step velocities, constant-velocity model. Measurement is [cx,cy,w,h]
// from a detection. The original DeepSORT paper parameterizes state via
// aspect ratio instead of width; using width/height directly is simpler to
// reason about and equally valid for a constant-velocity model.
//
// REQ-2.5's velocity/heading estimate is this filter's vx/vy state
// (ML-005) — opencv4nodejs (the PRD's originally specified optical-flow
// library) needs a full OpenCV source build with no prebuilt binary
// available, which isn't viable in this sandbox (same class of problem as
// gdal-async in SVC-002), so this Kalman-filter path is what's actually
// implemented; REQ-2.5 explicitly allows either "optical flow / Kalman
// filtering". Note this is image-space pixel velocity per processed
// frame, not real-world geodetic velocity — that conversion happens once
// fusion-svc (SVC-008, Phase 3) correlates a track with a real position.
import { matrix, identity, zeros, multiply, transpose, add, subtract, inv, type Matrix } from "mathjs";

const STATE_DIM = 8;
const MEASUREMENT_DIM = 4;

export interface BBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface Velocity {
  vx: number;
  vy: number;
}

function buildTransitionMatrix(): Matrix {
  // Position/size components each get + their own velocity component added
  // per step: F[i, i+4] = 1 for i in 0..3, on top of the identity.
  const F = identity(STATE_DIM) as Matrix;
  for (let i = 0; i < 4; i++) {
    F.set([i, i + 4], 1);
  }
  return F;
}

function buildMeasurementMatrix(): Matrix {
  const H = zeros(MEASUREMENT_DIM, STATE_DIM) as Matrix;
  for (let i = 0; i < MEASUREMENT_DIM; i++) {
    H.set([i, i], 1);
  }
  return H;
}

export class KalmanFilter {
  private state: Matrix;
  private covariance: Matrix;
  private readonly F = buildTransitionMatrix();
  private readonly H = buildMeasurementMatrix();
  private readonly Q: Matrix;
  private readonly R: Matrix;

  constructor(initial: BBox, processNoise = 1, measurementNoise = 1, initialUncertainty = 10) {
    this.state = matrix([initial.cx, initial.cy, initial.w, initial.h, 0, 0, 0, 0]);
    this.covariance = multiply(identity(STATE_DIM), initialUncertainty) as Matrix;
    this.Q = multiply(identity(STATE_DIM), processNoise) as Matrix;
    this.R = multiply(identity(MEASUREMENT_DIM), measurementNoise) as Matrix;
  }

  /** Advances the state by one step with no new measurement (occlusion, or the prior step before update()). */
  predict(): void {
    this.state = multiply(this.F, this.state) as Matrix;
    this.covariance = add(multiply(multiply(this.F, this.covariance), transpose(this.F)), this.Q) as Matrix;
  }

  /** Corrects the predicted state against a real detection's bounding box. */
  update(measurement: BBox): void {
    const z = matrix([measurement.cx, measurement.cy, measurement.w, measurement.h]);
    const predictedMeasurement = multiply(this.H, this.state) as Matrix;
    const innovation = subtract(z, predictedMeasurement) as Matrix;

    const innovationCovariance = add(multiply(multiply(this.H, this.covariance), transpose(this.H)), this.R) as Matrix;
    const kalmanGain = multiply(multiply(this.covariance, transpose(this.H)), inv(innovationCovariance)) as Matrix;

    this.state = add(this.state, multiply(kalmanGain, innovation)) as Matrix;
    const identityMinusKH = subtract(identity(STATE_DIM), multiply(kalmanGain, this.H)) as Matrix;
    this.covariance = multiply(identityMinusKH, this.covariance) as Matrix;
  }

  get bbox(): BBox {
    const s = this.state.toArray() as number[];
    return { cx: s[0]!, cy: s[1]!, w: s[2]!, h: s[3]! };
  }

  get velocity(): Velocity {
    const s = this.state.toArray() as number[];
    return { vx: s[4]!, vy: s[5]! };
  }

  /** REQ-2.5: heading in degrees, 0-360, measured clockwise from the image's +y (down) axis flipped to compass-style (0 = "up"/-y). */
  get headingDeg(): number {
    const { vx, vy } = this.velocity;
    if (vx === 0 && vy === 0) return 0;
    const deg = (Math.atan2(vx, -vy) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  get speed(): number {
    const { vx, vy } = this.velocity;
    return Math.sqrt(vx * vx + vy * vy);
  }
}
