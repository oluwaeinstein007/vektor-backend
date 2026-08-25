// Small, self-contained geo helpers — deliberately not imported from
// fusion-svc's src/pipeline/geo.ts. Services in this monorepo only share
// code through packages/*, never by reaching into a sibling service's src/
// (see packages/shared's re-export-only discipline); a duplicate ~15-line
// haversine is cheaper than promoting it to a shared package for one caller.
const EARTH_RADIUS_M = 6_371_000;
const DEG2RAD = Math.PI / 180;

export function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, in degrees [0, 360). */
export function bearingDegrees(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const dLon = (b.lon - a.lon) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const theta = Math.atan2(y, x);
  return ((theta * 180) / Math.PI + 360) % 360;
}
