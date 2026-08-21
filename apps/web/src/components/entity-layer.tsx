"use client";

import { useEffect } from "react";
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import { useEntityStore } from "@/stores/entity-store";
import { toFeatureCollection } from "@/lib/entity-geojson";

const SOURCE_ID = "entities";
const LAYER_ID = "entities";

/**
 * FE-002: live entity rendering on the base map. Keeps a MapLibre GeoJSON
 * source in sync with useEntityStore — the map layer itself only gets added
 * once (guarded by map.getSource), every update after that is a setData
 * call, not a layer re-add.
 *
 * Deliberately does NOT call useEntityUpdates itself — this component only
 * mounts once the map's "load" event has fired (see base-map.tsx), which
 * can take much longer than the socket connecting. entity:new/updated/lost
 * aren't replayed for a listener added after they were emitted, so the
 * subscription has to start as soon as the socket exists, not once the map
 * happens to be ready — see BaseMap, which calls useEntityUpdates
 * unconditionally.
 */
export function EntityLayer({ map, visible }: { map: MapLibreMap; visible: boolean }) {
  const entities = useEntityStore((s) => s.entities);

  useEffect(() => {
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, { type: "geojson", data: toFeatureCollection(new Map()) });
    map.addLayer({
      id: LAYER_ID,
      type: "circle",
      source: SOURCE_ID,
      paint: {
        "circle-radius": 6,
        "circle-color": ["get", "color"],
        "circle-stroke-width": 1,
        "circle-stroke-color": "#000000",
      },
    });
  }, [map]);

  useEffect(() => {
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(toFeatureCollection(entities));
  }, [map, entities]);

  useEffect(() => {
    if (!map.getLayer(LAYER_ID)) return;
    map.setLayoutProperty(LAYER_ID, "visibility", visible ? "visible" : "none");
  }, [map, visible]);

  return null;
}
