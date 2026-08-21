# web

FE-001: operator dashboard, Next.js 15 App Router. Currently: MapLibre GL base map + a real layer-toggle system (`src/components/base-map.tsx`). FE-002 (Socket.io entity rendering) and FE-003 (sensor health panel) aren't built yet — this covers FE-001 only.

## PMTiles

Set `NEXT_PUBLIC_PMTILES_URL` to a `map-tile-server` (SVC-006) archive URL to render VEKTOR's own map packs through the `pmtiles://` protocol. Without it, the map falls back to MapLibre's public demo style, so `pnpm dev` renders something before any EDGE-004 map pack exists.

```bash
# .env.local
NEXT_PUBLIC_PMTILES_URL=http://localhost:3006/tiles/area.pmtiles
```

## Local development

```bash
pnpm dev     # http://localhost:3000 (or the next free port)
pnpm build
pnpm lint    # eslint + tsc --noEmit
```
