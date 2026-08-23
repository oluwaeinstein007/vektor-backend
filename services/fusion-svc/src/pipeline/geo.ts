import type { GeoPosition, GeoVelocity } from "../ekf/extendedKalmanFilter.js";

const EARTH_RADIUS_M = 6_371_000;
const DEG2RAD = Math.PI / 180;

/** Great-circle distance between two lat/lon points, in meters. */
export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Linear dead-reckoning of a track's position `dtSeconds` forward — used
 * only for correlation *gating* (deciding whether a new observation is
 * plausibly the same physical track), never for the track's committed
 * state. Deliberately a plain function, not ExtendedKalmanFilter.predict(),
 * so gating candidates that don't end up matching never mutate a track's
 * actual filter state.
 */
export function extrapolate(position: GeoPosition, velocity: GeoVelocity, dtSeconds: number): GeoPosition {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.max(Math.cos(position.lat * DEG2RAD), 1e-6);
  return {
    lat: position.lat + (velocity.v_north_mps * dtSeconds) / mPerDegLat,
    lon: position.lon + (velocity.v_east_mps * dtSeconds) / mPerDegLon,
    alt_m: position.alt_m + velocity.v_up_mps * dtSeconds,
  };
}
