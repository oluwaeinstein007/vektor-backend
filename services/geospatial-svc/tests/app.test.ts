// Integration tests against a real Postgres+PostGIS instance — set
// DATABASE_URL before running (see README.md's "Local development"). This
// is deliberately not mocked: the whole point of SVC-005 is PostGIS spatial
// query correctness (ST_Contains bbox filtering), which a mocked query
// builder can't verify.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, type VektorDb } from "@vektor/db";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run these tests — see README.md");
}

let db: VektorDb;
let app: FastifyInstance;

before(async () => {
  db = createDb(DATABASE_URL!);
  app = buildApp({ db, logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  // node --test won't exit on its own otherwise — postgres.js keeps its
  // connection pool's sockets open (and the event loop alive with them)
  // until explicitly told to close.
  await db.$client.end();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE TABLE entities`);
});

async function insertEntity(overrides: Partial<Record<string, unknown>> = {}) {
  const id = randomUUID();
  const lon = overrides.lon ?? -122.42;
  const lat = overrides.lat ?? 37.77;
  const sourceSensors = (overrides.source_sensors as string[] | undefined) ?? ["sensor-1"];
  // drizzle-orm's `sql` tag hands array params through to the `postgres`
  // driver untouched, which stringifies a plain JS array via .toString()
  // (e.g. ["a","b"] -> "a,b") instead of a Postgres array literal — so this
  // builds the "{a,b}" literal by hand and casts it explicitly.
  const sourceSensorsLiteral = `{${sourceSensors.join(",")}}`;
  await db.execute(sql`
    INSERT INTO entities (entity_id, classification, confidence, status, affiliation, source_sensors, position, alt_m, accuracy_m)
    VALUES (
      ${id},
      ${overrides.classification ?? "GroundVehicle.Tracked"},
      ${overrides.confidence ?? 0.9},
      ${overrides.status ?? "ACTIVE"},
      ${overrides.affiliation ?? "UNKNOWN"},
      ${sourceSensorsLiteral}::text[],
      ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
      ${overrides.alt_m ?? 12.5},
      ${overrides.accuracy_m ?? 2.5}
    )
  `);
  return id;
}

test("GET /healthz", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
});

test("GET /api/v1/entities lists active entities", async () => {
  await insertEntity();
  await insertEntity({ status: "ARCHIVED" }); // must not appear — SVC-005 lists ACTIVE only

  const res = await app.inject({ method: "GET", url: "/api/v1/entities" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.length, 1);
});

test("GET /api/v1/entities filters by affiliation", async () => {
  await insertEntity({ affiliation: "HOSTILE" });
  await insertEntity({ affiliation: "FRIENDLY" });

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/entities?affiliation=HOSTILE",
  });
  const body = res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].affiliation, "HOSTILE");
});

test("GET /api/v1/entities filters by bbox — the real ST_Contains path", async () => {
  const insideId = await insertEntity({ lon: -122.42, lat: 37.77 }); // San Francisco
  await insertEntity({ lon: -74.0, lat: 40.71 }); // New York — outside the bbox below

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/entities?bbox=-123,37,-122,38", // roughly the SF Bay Area
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].entity_id, insideId);
});

test("GET /api/v1/entities/:id returns the full canonical Entity shape", async () => {
  const id = await insertEntity({ lon: -122.42, lat: 37.77, source_sensors: ["drone-7", "ais-1"] });

  const res = await app.inject({ method: "GET", url: `/api/v1/entities/${id}` });
  assert.equal(res.statusCode, 200);
  const entity = res.json();

  // Response schema validation (fastify-type-provider-zod, wired in
  // routes/entities.ts) already rejects a non-conforming payload before it
  // reaches the client — these assertions confirm the mapped *values* are
  // right, not just that something shaped like an Entity came back.
  assert.deepEqual(entity.source_sensors, ["drone-7", "ais-1"]);
  assert.equal(entity.position.lon, -122.42);
  assert.equal(entity.position.lat, 37.77);
  assert.equal(entity.position.alt_m, 12.5);
  assert.equal(entity.position.accuracy_m, 2.5);
  assert.equal(typeof entity.position.mgrs, "string");
  assert.ok(entity.position.mgrs.length > 0);
  assert.deepEqual(entity.kinematics, { speed_kmh: 0, heading_deg: 0, trajectory: [] });
});

test("GET /api/v1/entities/:id returns 404 for an unknown id", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/entities/${randomUUID()}`,
  });
  assert.equal(res.statusCode, 404);
});

test("GET /api/v1/entities/:id rejects a non-uuid id with 400", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/entities/not-a-uuid" });
  assert.equal(res.statusCode, 400);
});

test("POST /api/v1/entities/:id/tag adds a tag and is idempotent", async () => {
  const id = await insertEntity();

  const first = await app.inject({
    method: "POST",
    url: `/api/v1/entities/${id}/tag`,
    payload: { tag: "high-priority" },
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().metadata.tags, ["high-priority"]);

  // Tagging with the same tag again shouldn't duplicate it.
  const second = await app.inject({
    method: "POST",
    url: `/api/v1/entities/${id}/tag`,
    payload: { tag: "high-priority" },
  });
  assert.deepEqual(second.json().metadata.tags, ["high-priority"]);
});

test("POST /api/v1/entities/:id/tag returns 404 for an unknown id", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/entities/${randomUUID()}/tag`,
    payload: { tag: "x" },
  });
  assert.equal(res.statusCode, 404);
});
