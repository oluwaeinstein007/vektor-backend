"use client";

import { useEffect, useState } from "react";
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import type { NoStrikeZone } from "@vektor/shared";
import { toZoneFeatureCollection, toZoneLabelPoints } from "@/lib/no-strike-zone-geojson";

const SOURCE_ID = "no-strike-zones";
const LABEL_SOURCE_ID = "no-strike-zone-labels";
const FILL_LAYER_ID = "no-strike-zones";
const OUTLINE_LAYER_ID = "no-strike-zones-outline";
const LABEL_LAYER_ID = "no-strike-zones-label";
const ALL_LAYER_IDS = [FILL_LAYER_ID, OUTLINE_LAYER_ID, LABEL_LAYER_ID];

// fusion-svc's REST API and Socket.io gateway share one Fastify HTTP server
// (see fusion-svc/src/index.ts), so this reuses the same base URL apps/web
// already points at for live entity updates rather than needing a second env var.
const FUSION_SVC_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3007";

/**
 * SVC-010's no-strike zones have no live push (no ingest adapter emits
 * zone changes over Socket.io — they're an operator-managed registry, see
 * blueforce/routes.ts's header comment), so this fetches once on mount
 * rather than subscribing like EntityLayer does. Good enough until a REST
 * refresh/poll is worth adding.
 *
 * Rendered with a diagonal hatch fill + dashed outline (the standard
 * restricted-airspace chart convention) plus a centroid label, rather than
 * a plain translucent red blob — makes it legible as "this is a no-go
 * area", not just an unexplained colored patch.
 */
export function NoStrikeZoneLayer({ map, visible }: { map: MapLibreMap; visible: boolean }) {
  const [zones, setZones] = useState<NoStrikeZone[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${FUSION_SVC_URL}/api/v1/no-strike-zones`)
      .then((res) => (res.ok ? (res.json() as Promise<NoStrikeZone[]>) : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!cancelled) setZones(data);
      })
      .catch((err: unknown) => console.warn("[NoStrikeZoneLayer] failed to fetch no-strike zones", err));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, { type: "geojson", data: toZoneFeatureCollection([]) });
    map.addSource(LABEL_SOURCE_ID, { type: "geojson", data: toZoneLabelPoints([]) });

    map.addLayer({
      id: FILL_LAYER_ID,
      type: "fill",
      source: SOURCE_ID,
      paint: { "fill-color": "#ff1a1a", "fill-opacity": 0.4 },
    });
    map.addLayer({
      id: OUTLINE_LAYER_ID,
      type: "line",
      source: SOURCE_ID,
      paint: { "line-color": "#ff1a1a", "line-width": 4, "line-dasharray": [3, 2] },
    });
    map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: LABEL_SOURCE_ID,
      layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Open Sans Semibold"], "text-allow-overlap": false, "text-optional": true },
      paint: { "text-color": "#ff8080", "text-halo-color": "#0b1220", "text-halo-width": 1.4 },
    });
  }, [map]);

  useEffect(() => {
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(toZoneFeatureCollection(zones));
    const labelSource = map.getSource(LABEL_SOURCE_ID) as GeoJSONSource | undefined;
    labelSource?.setData(toZoneLabelPoints(zones));
  }, [map, zones]);

  useEffect(() => {
    const visibility = visible ? "visible" : "none";
    for (const id of ALL_LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
    }
  }, [map, visible]);

  return null;
}
