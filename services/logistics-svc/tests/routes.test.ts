// REST surface tests via app.inject() — real Postgres (inventory) + real
// pgRouting Postgres (routing), same pattern as fusion-svc/alert-svc's
// route tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, inventoryItems, inventoryForecasts } from "@vektor/db";
import { buildApp } from "../src/app.js";
import { createRoutingClient, ensureRoutingSchema } from "../src/routing/client.js";
import { seedGrid, DEFAULT_GRID, nodeId } from "../src/routing/seedNetwork.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const ROUTING_DATABASE_URL = process.env.ROUTING_DATABASE_URL ?? "postgres://postgres:vektor@localhost:5435/routing";

test("GET /api/v1/logistics/inventory returns items joined with their forecast", async (t) => {
  const db = createDb(DATABASE_URL);
  const routingSql = createRoutingClient(ROUTING_DATABASE_URL);
  const app = buildApp({ db, routingSql, logger: false });
  t.after(() => app.close());
  t.after(() => routingSql.end());
  t.after(() => db.$client.end());

  const itemId = randomUUID();
  await db.insert(inventoryItems).values({
    item_id: itemId,
    sku: `SKU-ROUTE-TEST-${itemId}`,
    name: "Route Test Item",
    category: "TEST",
    quantity: 30,
    reorder_threshold: 5,
    location: "FOB-TEST",
    updated_at: new Date(),
  });
  await db.insert(inventoryForecasts).values({
    item_id: itemId,
    quantity: 30,
    depletion_rate_per_hour: 1,
    hours_to_stockout: 30,
    low_stock: false,
  });

  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/logistics/inventory" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as Array<{ item: { item_id: string }; forecast: { low_stock: boolean } | null }>;
    const mine = body.find((r) => r.item.item_id === itemId);
    assert.ok(mine);
    assert.equal(mine.forecast?.low_stock, false);
  } finally {
    await db.delete(inventoryForecasts).where(eq(inventoryForecasts.item_id, itemId));
    await db.delete(inventoryItems).where(eq(inventoryItems.item_id, itemId));
  }
});

test("POST /api/v1/logistics/route computes a path, and blocking an edge changes it", async (t) => {
  const db = createDb(DATABASE_URL);
  const routingSql = createRoutingClient(ROUTING_DATABASE_URL);
  await ensureRoutingSchema(routingSql);
  await seedGrid(routingSql);
  const app = buildApp({ db, routingSql, logger: false });
  t.after(() => app.close());
  t.after(() => routingSql.end());
  t.after(() => db.$client.end());

  const { originLon, originLat, spacingDeg, size } = DEFAULT_GRID;
  const start = { lat: originLat, lon: originLon };
  const end = { lat: originLat, lon: originLon + spacingDeg };

  const before = await app.inject({ method: "POST", url: "/api/v1/logistics/route", payload: { start, end } });
  assert.equal(before.statusCode, 200);
  const beforeBody = before.json() as { path: unknown[]; distance_m: number };
  assert.equal(beforeBody.path.length, 2);

  const [edgeRow] = await routingSql<{ id: number }[]>`
    SELECT id::int AS id FROM road_edges WHERE source = ${nodeId(0, 0, size)} AND target = ${nodeId(0, 1, size)}
  `;

  const blockRes = await app.inject({
    method: "POST",
    url: `/api/v1/logistics/road-edges/${edgeRow!.id}/block`,
    payload: { blocked: true },
  });
  assert.equal(blockRes.statusCode, 200);

  const after = await app.inject({ method: "POST", url: "/api/v1/logistics/route", payload: { start, end } });
  const afterBody = after.json() as { path: unknown[]; distance_m: number; avoided_edge_ids: number[] };
  assert.ok(afterBody.path.length > 2);
  assert.ok(afterBody.avoided_edge_ids.includes(edgeRow!.id));

  const notFound = await app.inject({
    method: "POST",
    url: "/api/v1/logistics/road-edges/999999/block",
    payload: { blocked: true },
  });
  assert.equal(notFound.statusCode, 404);
});
