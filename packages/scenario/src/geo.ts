/**
 * NW-020 — great-circle geometry for scenario tracks. Pure functions, no
 * dependencies, so they can be tested without infrastructure.
 *
 * Distances are spheroidal-ish (haversine on a mean-radius sphere), which
 * is correct to ~0.3% and far better than the degrees-as-metres
 * approximation used elsewhere in this repo for display decimation. A
 * scenario's reported speed is derived from these, and a speed that is 2x
 * wrong at high latitude would make the synthetic data unusable for
 * anything calibrated against it.
 */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  lat: number;
  lon: number;
}

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Point a fraction of the way along the great circle from a to b.
 *
 * Spherical interpolation rather than linear lat/lon: linear is visibly
 * wrong over long legs and near the poles, and a scenario crossing an ocean
 * is exactly the case where someone would notice the track bowing the wrong
 * way on a map.
 */
export function interpolate(a: LatLon, b: LatLon, fraction: number): LatLon {
  const f = Math.min(1, Math.max(0, fraction));
  const lat1 = toRad(a.lat);
  const lon1 = toRad(a.lon);
  const lat2 = toRad(b.lat);
  const lon2 = toRad(b.lon);

  const d = haversineM(a, b) / EARTH_RADIUS_M;
  // Coincident (or near-coincident) points: sin(d) underflows and the
  // general formula produces NaN. A dwell — the same waypoint twice — is a
  // first-class scenario construct, so this is a normal path, not an edge
  // case to guard against defensively.
  if (d < 1e-12) return { lat: a.lat, lon: a.lon };

  const sinD = Math.sin(d);
  const A = Math.sin((1 - f) * d) / sinD;
  const B = Math.sin(f * d) / sinD;
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);

  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: toDeg(Math.atan2(y, x)),
  };
}

export const MPS_TO_KNOTS = 1.943844;
export const MPS_TO_KMH = 3.6;
