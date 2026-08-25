// Real pgRouting (pgrouting/pgrouting docker image, port 5435) — a real
// pgr_dijkstra call over a real synthetic 4x4 grid, not a hand-rolled
// shortest-path stand-in. See routing/seedNetwork.ts's header comment for
// why the grid itself is synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutingClient, ensureRoutingSchema } from "../src/routing/client.js";
import { seedGrid, DEFAULT_GRID, nodeId } from "../src/routing/seedNetwork.js";
import { findRoute, setEdgeBlocked } from "../src/routing/findRoute.js";

const ROUTING_DATABASE_URL = process.env.ROUTING_DATABASE_URL ?? "postgres://postgres:vektor@localhost:5435/routing";

test("findRoute: shortest path across the grid corner-to-corner sums real geography distance", async (t) => {
  const sql = createRoutingClient(ROUTING_DATABASE_URL);
  t.after(() => sql.end());
  await ensureRoutingSchema(sql);
  await seedGrid(sql);

  const { size, originLon, originLat, spacingDeg } = DEFAULT_GRID;
  const start = { lon: originLon, lat: originLat };
  const end = { lon: originLon + (size - 1) * spacingDeg, lat: originLat + (size - 1) * spacingDeg };

  const result = await findRoute(sql, { start, end });

  assert.ok(result.path.length > 0);
  // Manhattan-grid shortest path from corner to corner is always
  // (size-1)+(size-1) hops, regardless of which specific route it takes.
  assert.equal(result.path.length, 2 * (size - 1) + 1);
  assert.ok(result.distance_m > 0);
  assert.equal(result.avoided_edge_ids.length, 0); // nothing blocked yet
});

test("findRoute: a blocked edge is genuinely routed around, not just reported", async (t) => {
  const sql = createRoutingClient(ROUTING_DATABASE_URL);
  t.after(() => sql.end());
  await ensureRoutingSchema(sql);
  await seedGrid(sql);

  const { originLon, originLat, spacingDeg, size } = DEFAULT_GRID;
  // Direct east-neighbor edge from node (0,0) to (0,1) — the single most
  // direct hop for a start/end pair inside this row.
  const [edgeRow] = await sql<{ id: number }[]>`
    SELECT id::int AS id FROM road_edges WHERE source = ${nodeId(0, 0, size)} AND target = ${nodeId(0, 1, size)}
  `;
  assert.ok(edgeRow);

  const start = { lon: originLon, lat: originLat };
  const end = { lon: originLon + spacingDeg, lat: originLat };

  const before = await findRoute(sql, { start, end });
  assert.equal(before.path.length, 2); // direct hop, unblocked

  const blocked = await setEdgeBlocked(sql, edgeRow.id, true);
  assert.equal(blocked, true);

  const after = await findRoute(sql, { start, end });
  assert.ok(after.path.length > 2, "should now detour through at least one extra node");
  assert.ok(after.avoided_edge_ids.includes(edgeRow.id));
  assert.ok(after.distance_m > before.distance_m);

  await setEdgeBlocked(sql, edgeRow.id, false); // leave the fixture clean for the next test run
});
