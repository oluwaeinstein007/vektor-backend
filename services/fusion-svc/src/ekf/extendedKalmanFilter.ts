// SVC-008 (Phase 3): geodetic position/velocity smoothing — VEKTOR-PRD.md
// §9.7 ("EKF position smoothing (custom TS math)"). Same mathjs-for-linear-
// algebra approach as cv-inference-svc's DeepSORT KalmanFilter (ML-004), but
// genuinely *extended*: cv-inference-svc's filter operates in flat pixel
// space, where a constant-velocity model is already linear. This filter's
// state is lat/lon in degrees, and converting a constant real-world
// north/east velocity (m/s) into a lat/lon rate is NOT linear — a degree of
// longitude covers fewer meters the further you get from the equator
// (scaled by cos(latitude)), so the state-transition Jacobian couples the
// longitude row to the current latitude and must be recomputed every
// predict() step rather than being a fixed matrix.
import { matrix, identity, zeros, diag, multiply, transpose, add, subtract, inv, type Matrix } from "mathjs";

const STATE_DIM = 6; // [lat_deg, lon_deg, alt_m, v_north_mps, v_east_mps, v_up_mps]
const MEASUREMENT_DIM = 3; // [lat_deg, lon_deg, alt_m]
const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_320; // WGS84 mean-radius approximation, adequate at this system's accuracy targets

export interface GeoPosition {
  lat: number;
  lon: number;
  alt_m: number;
}

export interface GeoVelocity {
  v_north_mps: number;
  v_east_mps: number;
  v_up_mps: number;
}

function metersPerDegLon(latDeg: number): number {
  // Clamp near the poles so this never divides by ~0 — no sensor feed in
  // this system reports fixes there, but a degenerate Jacobian is worse
  // than a slightly-wrong-but-finite one.
  const cosLat = Math.max(Math.cos(latDeg * DEG2RAD), 1e-6);
  return METERS_PER_DEG_LAT * cosLat;
}

function buildMeasurementMatrix(): Matrix {
  const H = zeros(MEASUREMENT_DIM, STATE_DIM) as Matrix;
  for (let i = 0; i < MEASUREMENT_DIM; i++) H.set([i, i], 1);
  return H;
}

// Position (lat/lon degrees, alt meters) and velocity (m/s) states live on
// wildly different numeric scales — a single scalar noise value across all
// 6 dimensions (as cv-inference-svc's KalmanFilter uses, fine there since
// its whole state is pixels) starves the velocity states: with one small
// scalar Q, a degree-scale process variance is already tiny relative to
// position, but the *same* value is many orders of magnitude too small for
// an m/s velocity to ever accumulate uncertainty (and therefore Kalman
// gain) from repeated position innovations. Each noise/uncertainty input is
// a per-dimension variance instead, in the same units as that state.
export interface EkfNoiseConfig {
  /** Process variance per predict() step, degrees^2 (lat, lon) / m^2 (alt) / (m/s)^2 (velocities). */
  processVar?: { posDeg2: number; altM2: number; velMps2: number };
  /** Sensor fix accuracy, degrees^2 (lat, lon) / m^2 (alt). */
  measurementVar?: { posDeg2: number; altM2: number };
  /** Initial state uncertainty, same units as processVar. */
  initialVar?: { posDeg2: number; altM2: number; velMps2: number };
}

const DEFAULT_NOISE: Required<EkfNoiseConfig> = {
  // ~5m 1-sigma position noise per step, expressed in degrees^2.
  processVar: { posDeg2: (5 / METERS_PER_DEG_LAT) ** 2, altM2: 25, velMps2: 4 },
  // ~8m sensor fix accuracy (GPS-class).
  measurementVar: { posDeg2: (8 / METERS_PER_DEG_LAT) ** 2, altM2: 64 },
  // A brand-new track's velocity is essentially unknown until a couple of updates land.
  initialVar: { posDeg2: (20 / METERS_PER_DEG_LAT) ** 2, altM2: 400, velMps2: 100 },
};

/**
 * A single track's EKF state. One instance per fused entity — see
 * trackManager.ts for the per-entity lifecycle (creation on first fix,
 * predict/update per correlated observation, eviction on staleness).
 */
export class ExtendedKalmanFilter {
  private state: Matrix;
  private covariance: Matrix;
  private readonly H = buildMeasurementMatrix();
  private readonly Q: Matrix;
  private readonly R: Matrix;

  constructor(initial: GeoPosition, noise: EkfNoiseConfig = {}) {
    const processVar = noise.processVar ?? DEFAULT_NOISE.processVar;
    const measurementVar = noise.measurementVar ?? DEFAULT_NOISE.measurementVar;
    const initialVar = noise.initialVar ?? DEFAULT_NOISE.initialVar;

    this.state = matrix([initial.lat, initial.lon, initial.alt_m, 0, 0, 0]);
    // mathjs's diag() mirrors its input type — passed a plain array, it
    // returns a plain nested array, not a Matrix (no .toArray()/.set()).
    // Wrapping the vector with matrix() first forces a Matrix result.
    this.covariance = diag(
      matrix([initialVar.posDeg2, initialVar.posDeg2, initialVar.altM2, initialVar.velMps2, initialVar.velMps2, initialVar.velMps2]),
    ) as Matrix;
    this.Q = diag(
      matrix([processVar.posDeg2, processVar.posDeg2, processVar.altM2, processVar.velMps2, processVar.velMps2, processVar.velMps2]),
    ) as Matrix;
    this.R = diag(matrix([measurementVar.posDeg2, measurementVar.posDeg2, measurementVar.altM2])) as Matrix;
  }

  /** Advances the state by `dtSeconds` with no new measurement. */
  predict(dtSeconds: number): void {
    const s = this.state.toArray() as number[];
    const [lat, lon, alt, vNorth, vEast, vUp] = s as [number, number, number, number, number, number];

    const mPerDegLat = METERS_PER_DEG_LAT;
    const mPerDegLon = metersPerDegLon(lat);

    const F = identity(STATE_DIM) as Matrix;
    F.set([0, 3], dtSeconds / mPerDegLat); // d(lat')/d(v_north)
    F.set([2, 5], dtSeconds); // d(alt')/d(v_up)
    F.set([1, 4], dtSeconds / mPerDegLon); // d(lon')/d(v_east)
    // d(lon')/d(lat): longitude's rate depends on latitude via cos(lat) —
    // this cross term is exactly what makes this an *Extended* KF instead of
    // a plain linear one. d/dlat[1/(K*cos(lat*DEG2RAD))] = sin(lat*DEG2RAD)*DEG2RAD / (K*cos^2(lat*DEG2RAD)).
    const cosLat = Math.max(Math.cos(lat * DEG2RAD), 1e-6);
    const dLonRate_dLat = (vEast * dtSeconds * Math.sin(lat * DEG2RAD) * DEG2RAD) / (METERS_PER_DEG_LAT * cosLat * cosLat);
    F.set([1, 0], dLonRate_dLat);

    const predictedState = matrix([
      lat + (vNorth * dtSeconds) / mPerDegLat,
      lon + (vEast * dtSeconds) / mPerDegLon,
      alt + vUp * dtSeconds,
      vNorth,
      vEast,
      vUp,
    ]);

    this.state = predictedState;
    this.covariance = add(multiply(multiply(F, this.covariance), transpose(F)), this.Q) as Matrix;
  }

  /** Corrects the predicted state against a real position fix. */
  update(measurement: GeoPosition): void {
    const z = matrix([measurement.lat, measurement.lon, measurement.alt_m]);
    const predictedMeasurement = multiply(this.H, this.state) as Matrix;
    const innovation = subtract(z, predictedMeasurement) as Matrix;

    const innovationCovariance = add(multiply(multiply(this.H, this.covariance), transpose(this.H)), this.R) as Matrix;
    const kalmanGain = multiply(multiply(this.covariance, transpose(this.H)), inv(innovationCovariance)) as Matrix;

    this.state = add(this.state, multiply(kalmanGain, innovation)) as Matrix;
    const identityMinusKH = subtract(identity(STATE_DIM), multiply(kalmanGain, this.H)) as Matrix;
    this.covariance = multiply(identityMinusKH, this.covariance) as Matrix;
  }

  get position(): GeoPosition {
    const s = this.state.toArray() as number[];
    return { lat: s[0]!, lon: s[1]!, alt_m: s[2]! };
  }

  get velocity(): GeoVelocity {
    const s = this.state.toArray() as number[];
    return { v_north_mps: s[3]!, v_east_mps: s[4]!, v_up_mps: s[5]! };
  }

  /** REQ-3.4/kinematics.speed_kmh: ground speed from the horizontal velocity components. */
  get speedKmh(): number {
    const { v_north_mps, v_east_mps } = this.velocity;
    return Math.sqrt(v_north_mps ** 2 + v_east_mps ** 2) * 3.6;
  }

  /** Compass heading, 0-360, 0 = true north. */
  get headingDeg(): number {
    const { v_north_mps, v_east_mps } = this.velocity;
    if (v_north_mps === 0 && v_east_mps === 0) return 0;
    const deg = (Math.atan2(v_east_mps, v_north_mps) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  /** Position uncertainty (1-sigma, meters) for Entity.position.accuracy_m — the trace of the position sub-covariance, converted from degrees^2 to meters^2. */
  get accuracyM(): number {
    const c = this.covariance.toArray() as number[][];
    const latVarM = c[0]![0]! * METERS_PER_DEG_LAT ** 2;
    const lonVarM = c[1]![1]! * metersPerDegLon(this.position.lat) ** 2;
    return Math.sqrt(latVarM + lonVarM);
  }
}
