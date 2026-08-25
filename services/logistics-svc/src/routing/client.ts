// SVC-019 — pgRouting isn't installed on the main VEKTOR PostGIS instance
// (postgis/postgis:16-3.4-alpine has no pgrouting extension binary — see
// vektor-build-conventions memory) — logistics-svc's road network lives on
// its own dedicated Postgres instance (pgrouting/pgrouting image, which
// bundles both postgis and pgrouting) instead. Plain `postgres` client, not
// Drizzle: the entire routing surface is `pgr_dijkstra` raw SQL, so a typed
// query builder buys nothing here — same reasoning fusion-svc/blueforce's
// polygon queries already use for their `sql` escape hatch.
import postgres, { type Sql } from "postgres";

export function createRoutingClient(connectionString: string): Sql {
  return postgres(connectionString);
}

export async function ensureRoutingSchema(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS road_edges (
      id bigserial PRIMARY KEY,
      source bigint NOT NULL,
      target bigint NOT NULL,
      cost double precision NOT NULL,
      reverse_cost double precision NOT NULL,
      blocked boolean NOT NULL DEFAULT false,
      the_geom geometry(LineString, 4326) NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS road_nodes (
      id bigint PRIMARY KEY,
      lon double precision NOT NULL,
      lat double precision NOT NULL
    )
  `;
}
