"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { Protocol } from "pmtiles";
import "maplibre-gl/dist/maplibre-gl.css";
import { EntityLayer } from "./entity-layer";
import { SensorHealthPanel } from "./sensor-health-panel";
import { useEntityUpdates } from "@/hooks/useEntityUpdates";

export interface MapLayer {
  id: string;
  label: string;
  visible: boolean;
}

// FE-001's "layer system" — a small, real toggle registry other components
// (FE-002's entity layer, alert overlays, etc.) extend by adding entries
// here and a matching MapLibre layer id, not a placeholder.
const INITIAL_LAYERS: MapLayer[] = [
  { id: "entities", label: "Entities", visible: true },
  { id: "sensors", label: "Sensor Coverage", visible: true },
  { id: "no-strike-zones", label: "No-Strike Zones", visible: false },
];

/**
 * PMTiles archives this app serves through — points at map-tile-server
 * (SVC-006). Falls back to MapLibre's own public demo style when unset, so
 * `pnpm dev` renders a real base map before EDGE-004 has generated any
 * VEKTOR map packs yet.
 */
const PMTILES_URL = process.env.NEXT_PUBLIC_PMTILES_URL;
const FALLBACK_STYLE_URL = "https://demotiles.maplibre.org/style.json";

export function BaseMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [layers, setLayers] = useState(INITIAL_LAYERS);
  // Subscribed here, not inside EntityLayer: this runs as soon as the
  // socket connects, independent of the map's "load" event (which can take
  // much longer) — see entity-layer.tsx's comment for why that ordering
  // matters.
  useEntityUpdates((event, error) => console.warn(`[BaseMap] invalid ${event} payload`, error));
  // Separate from mapRef: FE-002's EntityLayer needs to render only once
  // MapLibre has actually finished loading the style (addSource/addLayer
  // throw before that), and a ref change alone doesn't trigger a re-render.
  const [readyMap, setReadyMap] = useState<MapLibreMap | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: PMTILES_URL
        ? {
            version: 8,
            sources: {
              vektor: { type: "vector", url: `pmtiles://${PMTILES_URL}` },
            },
            // A real basemap layer set (roads/buildings/land) gets added
            // once EDGE-004 map packs land — this is the minimum that
            // proves the pmtiles:// protocol is actually wired up.
            layers: [{ id: "background", type: "background", paint: { "background-color": "#0a0a0a" } }],
          }
        : FALLBACK_STYLE_URL,
      center: [0, 20],
      zoom: 2,
    });

    mapRef.current = map;
    map.on("load", () => setReadyMap(map));

    return () => {
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
      setReadyMap(null);
    };
  }, []);

  function toggleLayer(id: string) {
    let nextVisible = false;
    setLayers((prev) =>
      prev.map((layer) => {
        if (layer.id !== id) return layer;
        nextVisible = !layer.visible;
        return { ...layer, visible: nextVisible };
      }),
    );

    const map = mapRef.current;
    if (!map?.getLayer(id)) return; // no-op until FE-002 actually adds these MapLibre layers
    map.setLayoutProperty(id, "visibility", nextVisible ? "visible" : "none");
  }

  const entityLayerVisible = layers.find((l) => l.id === "entities")?.visible ?? true;

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {readyMap && <EntityLayer map={readyMap} visible={entityLayerVisible} />}
      <LayerPanel layers={layers} onToggle={toggleLayer} />
      <SensorHealthPanel />
    </div>
  );
}

function LayerPanel({
  layers,
  onToggle,
}: {
  layers: MapLayer[];
  onToggle: (id: string) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        background: "var(--background)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        fontSize: 14,
      }}
    >
      {layers.map((layer) => (
        <label key={layer.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={layer.visible}
            onChange={() => onToggle(layer.id)}
          />
          {layer.label}
        </label>
      ))}
    </div>
  );
}
