import type { CSSProperties } from "react";

// Shared by every map-overlay HUD panel (LayerPanel, SensorHealthPanel, any
// future one) — a fixed dark tactical palette rather than the app's shared
// shadcn/ui tokens (globals.css). Those are shared across every @vektor/ui
// consumer, but a map overlay HUD is its own visual register regardless of
// the host app's light/dark theme, the same way a real C2 display doesn't
// follow the OS's appearance setting.
export const HUD_PANEL_STYLE: CSSProperties = {
  background: "rgba(11, 18, 32, 0.92)",
  color: "#e5e7eb",
  border: "1px solid #1e293b",
  borderRadius: 4,
  padding: "10px 12px",
  fontSize: 12,
  fontFamily: "ui-monospace, 'Courier New', monospace",
  boxShadow: "0 0 0 1px rgba(59,158,255,0.15), 0 4px 16px rgba(0,0,0,0.5)",
};

export const HUD_PANEL_TITLE_STYLE: CSSProperties = {
  fontWeight: 700,
  letterSpacing: "0.08em",
  fontSize: 11,
  color: "#7dd3fc",
  borderBottom: "1px solid #1e293b",
  paddingBottom: 6,
  marginBottom: 8,
};
