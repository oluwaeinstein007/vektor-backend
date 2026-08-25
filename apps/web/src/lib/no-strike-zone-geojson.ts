import type { NoStrikeZone } from "@vektor/shared";

export function toZoneFeatureCollection(zones: NoStrikeZone[]): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  return {
    type: "FeatureCollection",
    features: zones.map((zone) => ({
      type: "Feature",
      id: zone.zone_id,
      geometry: { type: "Polygon", coordinates: [zone.polygon] },
      properties: { zone_id: zone.zone_id, name: zone.name, source: zone.source },
    })),
  };
}

/** Simple vertex-average centroid — accurate enough for label placement on these near-circular buffer polygons, not meant as a real geometric centroid. */
function ringCentroid(ring: [number, number][]): [number, number] {
  const [lonSum, latSum] = ring.reduce(([lon, lat], [pLon, pLat]) => [lon + pLon, lat + pLat], [0, 0]);
  return [lonSum / ring.length, latSum / ring.length];
}

export function toZoneLabelPoints(zones: NoStrikeZone[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: zones.map((zone) => ({
      type: "Feature",
      id: zone.zone_id,
      geometry: { type: "Point", coordinates: ringCentroid(zone.polygon) },
      properties: { label: `NO-STRIKE: ${zone.name.toUpperCase()}` },
    })),
  };
}
