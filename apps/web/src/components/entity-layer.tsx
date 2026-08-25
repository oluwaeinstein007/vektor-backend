"use client";

import { useEffect } from "react";
import type { Map as MapLibreMap, GeoJSONSource } from "maplibre-gl";
import { useEntityStore } from "@/stores/entity-store";
import { toFeatureCollection } from "@/lib/entity-geojson";
import { registerEntitySymbols } from "@/lib/entity-symbols";

const SOURCE_ID = "entities";
const FRAME_LAYER_ID = "entities-frame";
const GLYPH_LAYER_ID = "entities-glyph";
const LABEL_LAYER_ID = "entities-label";
const LAYER_IDS = [FRAME_LAYER_ID, GLYPH_LAYER_ID, LABEL_LAYER_ID];

/**
 * FE-002: live entity rendering on the base map. Keeps a MapLibre GeoJSON
 * source in sync with useEntityStore — the map layer itself only gets added
 * once (guarded by map.getSource), every update after that is a setData
 * call, not a layer re-add.
 *
 * Rendered as three stacked symbol layers reading the same source rather
 * than one plain circle: a frame (shape = affiliation, MIL-STD-2525-ish —
 * rectangle/diamond/square/circle for friendly/hostile/neutral/unknown), a
 * domain glyph on top (ship/aircraft/signal-emitter silhouette, see
 * entity-symbols.ts), and a text label underneath both. This is what makes
 * "what is that dot" answerable at a glance instead of everything being an
 * identical colored circle.
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

    registerEntitySymbols(map);
    map.addSource(SOURCE_ID, { type: "geojson", data: toFeatureCollection(new Map()) });

    map.addLayer({
      id: FRAME_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      layout: { "icon-image": ["get", "frame"], "icon-size": 0.5, "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["get", "color"], "icon-opacity": 0.95 },
    });
    map.addLayer({
      id: GLYPH_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      layout: {
        "icon-image": ["get", "glyph"],
        "icon-size": 0.34,
        "icon-rotate": ["get", "rotation"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
    map.addLayer({
      id: LABEL_LAYER_ID,
      type: "symbol",
      source: SOURCE_ID,
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Open Sans Semibold"],
        "text-size": 11,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-allow-overlap": false,
        "text-optional": true,
      },
      paint: {
        "text-color": "#e5e7eb",
        "text-halo-color": "#0b1220",
        "text-halo-width": 1.4,
      },
    });
  }, [map]);

  useEffect(() => {
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    source?.setData(toFeatureCollection(entities));
  }, [map, entities]);

  useEffect(() => {
    const visibility = visible ? "visible" : "none";
    for (const id of LAYER_IDS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
    }
  }, [map, visible]);

  return null;
}
