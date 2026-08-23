// packages/db/src/schema/blueForce.ts — SVC-010 (Phase 3), VEKTOR-PRD.md REQ-3.3.
// Storage layer for @vektor/proto's BlueForceAsset/NoStrikeZone. Same
// mapper-not-column-copy discipline as entities.ts: services/fusion-svc's
// mappers translate rows into the wire contract, never `as`.
import { pgTable, uuid, text, real, geometry, customType, timestamp } from "drizzle-orm/pg-core";

export const blueForceAssets = pgTable("blue_force_assets", {
  asset_id: uuid("asset_id").primaryKey().defaultRandom(),
  callsign: text("callsign").notNull(),
  classification: text("classification").notNull(),
  position: geometry("position", { type: "point", srid: 4326 }).notNull(),
  alt_m: real("alt_m").notNull().default(0),
  buffer_radius_m: real("buffer_radius_m").notNull(),
  last_updated: timestamp("last_updated").defaultNow(),
});

// drizzle-orm's built-in `geometry()` helper only supports POINT — its
// getSQLType() hardcodes "geometry(point)" and mapFromDriverValue always
// runs the point-shaped EWKB parser (node_modules/drizzle-orm/pg-core/
// columns/postgis_extension/geometry.js), regardless of any `type` passed
// in config. A polygon column therefore can't go through it. This
// `customType` exists only to get correct DDL out of drizzle-kit; no query
// in this codebase reads or writes `geom` through Drizzle's typed
// select()/insert() — every touch point is a raw `sql` fragment using
// ST_GeomFromText/ST_AsGeoJSON (see services/fusion-svc/src/blueforce/
// queries.ts), same as entities.ts's bbox query already does for anything
// PostGIS-specific.
const geometryPolygon = customType<{ data: string }>({
  dataType() {
    return "geometry(polygon)";
  },
});

export const noStrikeZones = pgTable("no_strike_zones", {
  zone_id: uuid("zone_id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  // FK left off deliberately: a BLUE_FORCE_BUFFER zone's asset can be
  // deleted (asset withdrawn) without cascading — the zone just stops being
  // refreshed and becomes analyst-owned until explicitly removed.
  source_asset_id: uuid("source_asset_id"),
  geom: geometryPolygon("geom").notNull(),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});
