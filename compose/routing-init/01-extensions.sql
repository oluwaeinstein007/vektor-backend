-- NW-003 follow-up. The pgrouting image BUNDLES postgis and pgrouting; it
-- does not CREATE the extensions in your database. `vektor_routing` came up
-- with only plpgsql, so every routing test failed: ensureRoutingSchema
-- creates road_edges with a `geometry(LineString, 4326)` column and
-- findRoute calls pgr_dijkstra, neither of which exists without these.
--
-- Table creation stays in the application (routing/client.ts's
-- ensureRoutingSchema) — only the extensions belong here, because they are
-- the part the application cannot create for itself without superuser.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
