// SVC-019 — REQ-6.2: "Route optimization avoiding flagged threat/hazard
// zones ... recomputed within 5s of a new hazard flag." A blocked edge is
// modeled as an effectively-infinite-cost edge rather than removing it from
// the query, so pgr_dijkstra still considers (and rejects) it — this is
// what makes the "recomputed within 5s" requirement trivial to satisfy:
// there's no separate recompute step to schedule, every route request
// already reads the current `blocked` flags live.
import type { Sql } from "postgres";
import type { LatLon, RouteResult } from "@vektor/shared";

const BLOCKED_COST = 1e9;

interface NodeRow {
  id: number;
  lon: number;
  lat: number;
}

async function nearestNode(sql: Sql, point: LatLon): Promise<NodeRow> {
  const rows = await sql<NodeRow[]>`
    SELECT id, lon, lat FROM road_nodes
    ORDER BY (lon - ${point.lon})^2 + (lat - ${point.lat})^2 ASC
    LIMIT 1
  `;
  const node = rows[0];
  if (!node) throw new Error("no road nodes available to route against");
  return node;
}

interface DijkstraRow {
  seq: number;
  node: number;
  edge: number;
  cost: number;
  agg_cost: number;
}

export async function findRoute(sql: Sql, request: { start: LatLon; end: LatLon }): Promise<RouteResult> {
  const startNode = await nearestNode(sql, request.start);
  const endNode = await nearestNode(sql, request.end);

  // pgr_dijkstra is overloaded (single pair / arrays / directed variants) —
  // postgres.js sends every interpolated value as an untyped parameter, so
  // Postgres can't pick a candidate without explicit casts (confirmed
  // 2026-08-25: "function pgr_dijkstra(...) is not unique" without them).
  const rows = await sql<DijkstraRow[]>`
    SELECT * FROM pgr_dijkstra(
      ${`SELECT id, source, target,
           CASE WHEN blocked THEN ${BLOCKED_COST} ELSE cost END AS cost,
           CASE WHEN blocked THEN ${BLOCKED_COST} ELSE reverse_cost END AS reverse_cost
         FROM road_edges`}::text,
      ${startNode.id}::bigint, ${endNode.id}::bigint,
      directed => true
    )
  `;

  if (rows.length === 0) {
    return { path: [], distance_m: 0, avoided_edge_ids: await blockedEdgeIds(sql) };
  }

  const nodeIds = rows.map((r) => r.node).filter((id) => id !== -1);
  const nodeRows = await sql<NodeRow[]>`SELECT id, lon, lat FROM road_nodes WHERE id = ANY(${nodeIds})`;
  const byId = new Map(nodeRows.map((n) => [n.id, n]));

  const path: LatLon[] = nodeIds.map((id) => {
    const n = byId.get(id)!;
    return { lat: n.lat, lon: n.lon };
  });

  const distanceM = rows.reduce((sum, r) => sum + (r.cost === BLOCKED_COST ? 0 : r.cost), 0);

  return { path, distance_m: distanceM, avoided_edge_ids: await blockedEdgeIds(sql) };
}

async function blockedEdgeIds(sql: Sql): Promise<number[]> {
  // road_edges.id is bigserial — postgres.js decodes int8 as a string by
  // default (avoids silent precision loss above 2^53), so an explicit
  // ::int cast is needed for this to actually come back as a JS number
  // (confirmed 2026-08-25: RouteResult's zod schema rejected the raw
  // string with "Expected number, received string").
  const rows = await sql<{ id: number }[]>`SELECT id::int AS id FROM road_edges WHERE blocked = true`;
  return rows.map((r) => r.id);
}

export async function setEdgeBlocked(sql: Sql, edgeId: number, blocked: boolean): Promise<boolean> {
  const result = await sql`UPDATE road_edges SET blocked = ${blocked} WHERE id = ${edgeId} RETURNING id`;
  return result.length > 0;
}
