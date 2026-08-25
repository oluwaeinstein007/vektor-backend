import type { Map as MapLibreMap } from "maplibre-gl";
import type { Entity } from "@vektor/shared";

// Loosely follows MIL-STD-2525/APP-6 affiliation convention: friendly is a
// rectangle, hostile a diamond, neutral a square, unknown a circle — frame
// *shape* carries affiliation so it still reads correctly if colors are
// ever changed, same as the real standard's reasoning for using shape, not
// just color, as the primary cue.
export const AFFILIATION_COLORS: Record<Entity["affiliation"], string> = {
  FRIENDLY: "#3b9eff",
  HOSTILE: "#ff4d4d",
  NEUTRAL: "#22c55e",
  UNKNOWN: "#eab308",
};

const FRAME_SHAPES = ["rect", "diamond", "square", "circle"] as const;
type FrameShape = (typeof FRAME_SHAPES)[number];

export const AFFILIATION_FRAME: Record<Entity["affiliation"], FrameShape> = {
  FRIENDLY: "rect",
  HOSTILE: "diamond",
  NEUTRAL: "square",
  UNKNOWN: "circle",
};

const GLYPH_KINDS = ["vessel", "aircraft", "emitter", "unknown"] as const;
export type GlyphKind = (typeof GLYPH_KINDS)[number];

/** Best-effort mapping from the free-text `classification` field (e.g. "Vessel.AIS", "RadarType.Search") to a glyph + a short human label. */
export function classifyEntity(classification: string): { glyph: GlyphKind; label: string } {
  if (classification.startsWith("Vessel")) return { glyph: "vessel", label: "Vessel" };
  if (classification.startsWith("Aircraft")) return { glyph: "aircraft", label: "Aircraft" };
  if (classification.startsWith("RadarType") || classification.startsWith("Emitter")) {
    return { glyph: "emitter", label: "Emitter" };
  }
  return { glyph: "unknown", label: classification.split(".")[0] ?? classification };
}

function canvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  return { canvas: c, ctx };
}

// map.addImage()'s TS signature doesn't include HTMLCanvasElement even
// though every image type it does accept is just a pixel buffer —
// ImageData is the one it's explicitly typed for, so every icon is
// converted to that right before registration.
function toImageData(c: HTMLCanvasElement): ImageData {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  return ctx.getImageData(0, 0, c.width, c.height);
}

const SIZE = 64;
const MID = SIZE / 2;

/** Frame silhouettes — solid black on transparent, registered with `sdf: true` so `icon-color` can tint them per affiliation at render time. */
function drawFrame(shape: FrameShape): HTMLCanvasElement {
  const { canvas: c, ctx } = canvas(SIZE);
  ctx.fillStyle = "#000";
  const r = 22;
  switch (shape) {
    case "rect": {
      const w = 40;
      const h = 30;
      const radius = 5;
      const x = MID - w / 2;
      const y = MID - h / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.fill();
      break;
    }
    case "diamond": {
      ctx.beginPath();
      ctx.moveTo(MID, MID - r);
      ctx.lineTo(MID + r, MID);
      ctx.lineTo(MID, MID + r);
      ctx.lineTo(MID - r, MID);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "square": {
      const s = 32;
      ctx.fillRect(MID - s / 2, MID - s / 2, s, s);
      break;
    }
    case "circle": {
      ctx.beginPath();
      ctx.arc(MID, MID, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  return c;
}

/** Domain glyphs — pre-colored (white fill, dark outline) so they read clearly over any of the four affiliation frame colors; not SDF-tinted. */
function drawGlyph(kind: GlyphKind): HTMLCanvasElement {
  const { canvas: c, ctx } = canvas(SIZE);
  ctx.fillStyle = "#0b1220";
  ctx.strokeStyle = "#0b1220";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";

  switch (kind) {
    case "aircraft": {
      // Simplified dart/plane silhouette, nose pointing up (north) — rotated
      // per-feature by icon-rotate using kinematics.heading_deg so it always
      // points the way the track is actually moving, ATC-style.
      ctx.beginPath();
      ctx.moveTo(MID, 8);
      ctx.lineTo(MID + 18, 42);
      ctx.lineTo(MID + 7, 36);
      ctx.lineTo(MID + 5, 54);
      ctx.lineTo(MID - 5, 54);
      ctx.lineTo(MID - 7, 36);
      ctx.lineTo(MID - 18, 42);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "vessel": {
      // Top-down hull silhouette (pointed bow, flat stern) — the standard
      // AIS/maritime-tracker convention, rotated by the EKF-smoothed
      // heading (see entity-geojson.ts) so it visibly points the way the
      // vessel is actually moving.
      ctx.beginPath();
      ctx.moveTo(MID, 8);
      ctx.quadraticCurveTo(MID + 15, 30, MID + 9, 52);
      ctx.lineTo(MID - 9, 52);
      ctx.quadraticCurveTo(MID - 15, 30, MID, 8);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "emitter": {
      // Radiating signal arcs over a source point — reads as "transmitting",
      // the natural glyph for an EW/RF emission with no physical hull/frame.
      ctx.beginPath();
      ctx.arc(MID, 46, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 4;
      for (const radius of [12, 20, 28]) {
        ctx.beginPath();
        ctx.arc(MID, 46, radius, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
      break;
    }
    case "unknown": {
      ctx.font = "bold 26px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", MID, MID + 1);
      break;
    }
  }
  return c;
}

/** Idempotent via `map.hasImage` — safe to call every time EntityLayer mounts, including against a map instance that already has these registered. */
export function registerEntitySymbols(map: MapLibreMap): void {
  for (const shape of FRAME_SHAPES) {
    const id = `frame-${shape}`;
    if (!map.hasImage(id)) map.addImage(id, toImageData(drawFrame(shape)), { sdf: true });
  }
  for (const kind of GLYPH_KINDS) {
    const id = `glyph-${kind}`;
    if (!map.hasImage(id)) map.addImage(id, toImageData(drawGlyph(kind)));
  }
}
