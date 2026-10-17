// NW-018 (UC-2.2) integration tests. Real Postgres+PostGIS, same as
// app.test.ts and for the same reason: every interesting thing here is a
// PostGIS or window-function behaviour (DISTINCT ON, ST_Simplify's M
// handling, DBSCAN chaining, partition routing) that a mocked query builder
// cannot verify. Set DATABASE_URL before running.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb, type VektorDb } from "@vektor/db";
import { createTestAuth } from "@vektor/auth/testing";
import { buildApp } from "../src/app.js";
import { recordObservation, resetEnsuredDaysCache, applyRetention } from "../src/history/writer.js";
import type { FastifyInstance } from "fastify";
import type { Entity } from "@vektor/shared";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run these tests — see README.md");
}

let db: VektorDb;
let app: FastifyInstance;
let analystAuthHeader: { authorization: string };

const ENTITY_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENTITY_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const DAY = "2026-10-14";
const T0 = Date.parse(`${DAY}T00:00:00.000Z`);

before(async () => {
  db = createDb(DATABASE_URL!);
  const testAuth = await createTestAuth();
  app = buildApp({ db, auth: testAuth.authOptions, logger: false });
  await app.ready();
  analystAuthHeader = await testAuth.authHeader({ sub: "analyst-1", roles: ["Analyst"] });
});

after(async () => {
  await app.close();
  await db.$client.end();
});

beforeEach(async () => {
  // TRUNCATE on the parent cascades to every partition.
  await db.execute(sql`TRUNCATE TABLE entity_history`);
  resetEnsuredDaysCache();
  await db.execute(sql`SELECT ensure_entity_history_partition(${DAY}::date)`);
});

async function insertPoint(
  entityId: string,
  offsetS: number,
  lon: number,
  lat: number,
  overrides: { speed_kmh?: number; affiliation?: string; classification?: string } = {},
) {
  await db.execute(sql`
    INSERT INTO entity_history
      (entity_id, ts, position, alt_m, speed_kmh, heading_deg, confidence, classification, affiliation, status)
    VALUES (
      ${entityId}::uuid,
      ${new Date(T0 + offsetS * 1000).toISOString()}::timestamptz,
      ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326),
      0, ${overrides.speed_kmh ?? 10}, 90, 0.85,
      ${overrides.classification ?? "Vessel.Cargo"},
      ${overrides.affiliation ?? "NEUTRAL"},
      'ACTIVE'
    )
    ON CONFLICT (entity_id, ts) DO NOTHING
  `);
}

function iso(offsetS: number): string {
  return new Date(T0 + offsetS * 1000).toISOString();
}

// ---------------------------------------------------------------- coverage

test("coverage reports nulls when no history exists at all", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/entities/history/coverage",
    headers: analystAuthHeader,
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { earliest: null, latest: null, entity_count: 0, point_count: 0 });
});

test("coverage reports the real bounds, so a time-slider can size itself to actual data", async () => {
  await insertPoint(ENTITY_A, 0, 4.0, 52.0);
  await insertPoint(ENTITY_A, 600, 4.1, 52.0);
  await insertPoint(ENTITY_B, 300, 5.0, 53.0);

  const body = (
    await app.inject({ method: "GET", url: "/api/v1/entities/history/coverage", headers: analystAuthHeader })
  ).json();

  assert.equal(body.earliest, iso(0));
  assert.equal(body.latest, iso(600));
  assert.equal(body.entity_count, 2);
  assert.equal(body.point_count, 3);
});

// ---------------------------------------------------------------- snapshot

test("snapshot returns each entity's last state AT OR BEFORE the instant, never after it", async () => {
  await insertPoint(ENTITY_A, 0, 4.0, 52.0);
  await insertPoint(ENTITY_A, 60, 4.1, 52.0);
  // Deliberately after the queried instant: a playback that shows positions
  // the system had not yet observed is showing something that never happened.
  await insertPoint(ENTITY_A, 300, 4.9, 52.0);

  const body = (
    await app.inject({
      method: "GET",
      url: `/api/v1/entities/at?ts=${encodeURIComponent(iso(120))}`,
      headers: analystAuthHeader,
    })
  ).json();

  assert.equal(body.entities.length, 1);
  assert.equal(body.entities[0].position.lon, 4.1);
  assert.equal(body.entities[0].observed_at, iso(60));
  assert.equal(body.entities[0].staleness_s, 60);
});

test("snapshot returns exactly one row per entity", async () => {
  for (let i = 0; i < 5; i++) await insertPoint(ENTITY_A, i * 10, 4.0 + i * 0.01, 52.0);
  for (let i = 0; i < 5; i++) await insertPoint(ENTITY_B, i * 10, 5.0 + i * 0.01, 53.0);

  const body = (
    await app.inject({
      method: "GET",
      url: `/api/v1/entities/at?ts=${encodeURIComponent(iso(100))}`,
      headers: analystAuthHeader,
    })
  ).json();

  assert.equal(body.entities.length, 2);
  assert.deepEqual(body.entities.map((e: { entity_id: string }) => e.entity_id).sort(), [ENTITY_A, ENTITY_B].sort());
});

test("snapshot drops entities staler than max_staleness_s", async () => {
  // Without this floor, scrubbing to any instant renders every entity ever
  // seen — including ones last detected days earlier — as if present.
  await insertPoint(ENTITY_A, 0, 4.0, 52.0);
  await insertPoint(ENTITY_B, 3000, 5.0, 53.0);

  const url = `/api/v1/entities/at?ts=${encodeURIComponent(iso(3060))}&max_staleness_s=300`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.equal(body.entities.length, 1, "the hour-stale entity should have been dropped");
  assert.equal(body.entities[0].entity_id, ENTITY_B);
});

test("snapshot scopes to the bbox so scrubbing one harbour does not pull the world", async () => {
  await insertPoint(ENTITY_A, 0, 4.0, 52.0); // inside
  await insertPoint(ENTITY_B, 0, -74.0, 40.7); // New York — outside

  const url = `/api/v1/entities/at?ts=${encodeURIComponent(iso(10))}&bbox=3,51,5,53`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.equal(body.entities.length, 1);
  assert.equal(body.entities[0].entity_id, ENTITY_A);
});

test("snapshot computes mgrs, which is never stored", async () => {
  await insertPoint(ENTITY_A, 0, 4.0, 52.0);
  const body = (
    await app.inject({
      method: "GET",
      url: `/api/v1/entities/at?ts=${encodeURIComponent(iso(10))}`,
      headers: analystAuthHeader,
    })
  ).json();
  assert.equal(typeof body.entities[0].position.mgrs, "string");
  assert.ok(body.entities[0].position.mgrs.length > 0);
});

// ------------------------------------------------------------------- track

test("track returns every point in time order when under the budget", async () => {
  for (let i = 0; i < 10; i++) await insertPoint(ENTITY_A, i * 60, 4.0 + i * 0.01, 52.0);

  const url = `/api/v1/entities/${ENTITY_A}/history?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(600))}`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.equal(body.points.length, 10);
  assert.equal(body.total_points, 10);
  assert.equal(body.decimated, false);
  const times = body.points.map((p: { ts: string }) => Date.parse(p.ts));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "points must come back in time order");
});

test("track decimates above the budget, keeps the real endpoints, and says it did", async () => {
  // A curved track so Douglas-Peucker has real shape to preserve.
  for (let i = 0; i < 400; i++) {
    await insertPoint(ENTITY_A, i * 10, 4.0 + i * 0.001, 52.0 + Math.sin(i / 20) * 0.01);
  }

  const url =
    `/api/v1/entities/${ENTITY_A}/history?from=${encodeURIComponent(iso(0))}` +
    `&to=${encodeURIComponent(iso(4000))}&max_points=50&simplify_tolerance_m=1`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.equal(body.total_points, 400);
  assert.ok(body.points.length <= 50, `promised at most 50 points, got ${body.points.length}`);
  assert.equal(body.decimated, true);
  // The track must still start and end where the entity actually did.
  assert.equal(body.points[0].ts, iso(0));
  assert.equal(body.points[body.points.length - 1].ts, iso(3990));
});

test("track carries the attributes a map layer needs, not just coordinates", async () => {
  await insertPoint(ENTITY_A, 0, 4.0, 52.0, { affiliation: "HOSTILE", classification: "Aircraft.Fixed" });
  await insertPoint(ENTITY_A, 60, 4.1, 52.0, { affiliation: "HOSTILE", classification: "Aircraft.Fixed" });

  const url = `/api/v1/entities/${ENTITY_A}/history?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(120))}`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.equal(body.affiliation, "HOSTILE");
  assert.equal(body.classification, "Aircraft.Fixed");
  assert.equal(body.points[0].speed_kmh, 10);
  assert.equal(body.points[0].heading_deg, 90);
});

test("track 404s when the entity has no history in the window — distinct from the route being absent", async () => {
  const url = `/api/v1/entities/${randomUUID()}/history?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(600))}`;
  const res = await app.inject({ method: "GET", url, headers: analystAuthHeader });
  assert.equal(res.statusCode, 404);
});

test("track rejects an inverted range instead of silently returning nothing", async () => {
  // Zero rows would read to the operator as "this entity has no history"
  // rather than "your request was backwards".
  const url = `/api/v1/entities/${ENTITY_A}/history?from=${encodeURIComponent(iso(600))}&to=${encodeURIComponent(iso(0))}`;
  const res = await app.inject({ method: "GET", url, headers: analystAuthHeader });
  assert.equal(res.statusCode, 400);
});

// --------------------------------------------------------- pattern of life

test("pattern-of-life finds a repeat dwell as ONE place with TWO visits", async () => {
  // Berth 00:00-00:40, transit away, berth again 01:40-02:20. The naive
  // implementation (DBSCAN over raw points) returns one cluster spanning
  // the whole track with a single visit — see queries.ts for why.
  const BERTH: [number, number] = [4.0, 52.0];
  for (let s = 0; s <= 2400; s += 60) await insertPoint(ENTITY_A, s, BERTH[0], BERTH[1], { speed_kmh: 0 });
  for (let i = 1; i <= 20; i++) await insertPoint(ENTITY_A, 2400 + i * 60, 4.0 + i * 0.004, 52.0, { speed_kmh: 14 });
  for (let i = 1; i <= 20; i++) await insertPoint(ENTITY_A, 3600 + i * 60, 4.08 - i * 0.004, 52.0, { speed_kmh: 14 });
  for (let s = 6000; s <= 8400; s += 60) await insertPoint(ENTITY_A, s, BERTH[0], BERTH[1], { speed_kmh: 0 });

  const url =
    `/api/v1/entities/${ENTITY_A}/pattern-of-life?from=${encodeURIComponent(iso(0))}` +
    `&to=${encodeURIComponent(iso(8400))}&cluster_radius_m=150&min_dwell_s=300`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.equal(body.clusters.length, 1, "the two berth periods are one place, not two");
  assert.equal(body.clusters[0].visits, 2, "they are two separate visits, not one long stay");
  // The centroid must be the berth, not the middle of the transit.
  assert.ok(Math.abs(body.clusters[0].lon - BERTH[0]) < 0.01, `centroid lon ${body.clusters[0].lon}`);
  assert.ok(Math.abs(body.clusters[0].lat - BERTH[1]) < 0.01, `centroid lat ${body.clusters[0].lat}`);
  assert.ok(body.clusters[0].total_dwell_s >= 4000, `expected ~4800s dwell, got ${body.clusters[0].total_dwell_s}`);
});

test("pattern-of-life never reports more dwell than the window contains", async () => {
  // Overlapping clusters can sum past the window; a "107% stationary"
  // figure destroys trust in every other number on screen.
  for (let s = 0; s <= 3600; s += 60) await insertPoint(ENTITY_A, s, 4.0, 52.0, { speed_kmh: 0 });

  const url =
    `/api/v1/entities/${ENTITY_A}/pattern-of-life?from=${encodeURIComponent(iso(0))}` +
    `&to=${encodeURIComponent(iso(3600))}`;
  const body = (await app.inject({ method: "GET", url, headers: analystAuthHeader })).json();

  assert.ok(body.dwell_fraction <= 1, `dwell_fraction was ${body.dwell_fraction}`);
  assert.ok(body.dwell_fraction > 0.9, `a stationary hour should read as mostly dwell, got ${body.dwell_fraction}`);
});

// ------------------------------------------------------------- projector

test("recordObservation is idempotent, so a Kafka replay cannot double a track", async () => {
  const entity: Entity = {
    entity_id: ENTITY_A,
    classification: "Vessel.Cargo",
    confidence: 0.9,
    status: "ACTIVE",
    affiliation: "NEUTRAL",
    source_sensors: ["ais-1"],
    position: { lat: 52.0, lon: 4.0, alt_m: 0, mgrs: "31UET0000000000", accuracy_m: 5 },
    kinematics: { speed_kmh: 10, heading_deg: 90, trajectory: [] },
    metadata: { tags: [], analyst_notes: "", no_strike: false },
    first_detected: iso(0),
    last_updated: iso(0),
  };

  await recordObservation(db, entity, new Date(T0));
  await recordObservation(db, entity, new Date(T0));
  await recordObservation(db, entity, new Date(T0));

  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM entity_history WHERE entity_id = ${ENTITY_A}::uuid`);
  assert.equal(Number((rows as unknown as Array<{ n: number }>)[0]!.n), 1);
});

test("recordObservation creates the day partition it needs", async () => {
  // A day with no partition yet: without ensure, the insert fails outright
  // (there is deliberately no DEFAULT partition — see migration 0009).
  const futureDay = new Date(T0 + 40 * 86_400_000);
  const entity: Entity = {
    entity_id: ENTITY_B,
    classification: "Vessel.Cargo",
    confidence: 0.9,
    status: "ACTIVE",
    affiliation: "NEUTRAL",
    source_sensors: [],
    position: { lat: 53.0, lon: 5.0, alt_m: 0, mgrs: "31UET0000000000", accuracy_m: 5 },
    kinematics: { speed_kmh: 0, heading_deg: 0, trajectory: [] },
    metadata: { tags: [], analyst_notes: "", no_strike: false },
    first_detected: futureDay.toISOString(),
    last_updated: futureDay.toISOString(),
  };

  await recordObservation(db, entity, futureDay);

  const partitionName = `entity_history_${futureDay.toISOString().slice(0, 10).replace(/-/g, "")}`;
  const rows = await db.execute(sql`SELECT count(*)::int AS n FROM pg_class WHERE relname = ${partitionName}`);
  assert.equal(Number((rows as unknown as Array<{ n: number }>)[0]!.n), 1, `expected partition ${partitionName}`);

  await db.execute(sql`DROP TABLE IF EXISTS ${sql.identifier(partitionName)}`);
});

test("applyRetention drops whole partitions rather than deleting rows", async () => {
  await insertPoint(ENTITY_A, 0, 4.0, 52.0);
  const before = await db.execute(sql`SELECT count(*)::int AS n FROM entity_history`);
  assert.equal(Number((before as unknown as Array<{ n: number }>)[0]!.n), 1);

  // The seeded day is far in the past relative to now(), so a 1-day window
  // must drop it.
  const dropped = await applyRetention(db, 1);
  assert.ok(dropped >= 1, `expected at least one partition dropped, got ${dropped}`);

  const after = await db.execute(sql`SELECT count(*)::int AS n FROM entity_history`);
  assert.equal(Number((after as unknown as Array<{ n: number }>)[0]!.n), 0);
});

// ------------------------------------------------------------------- RBAC

test("SEC-003: history routes reject an unauthenticated caller with 401", async () => {
  for (const url of [
    "/api/v1/entities/history/coverage",
    `/api/v1/entities/at?ts=${encodeURIComponent(iso(0))}`,
    `/api/v1/entities/${ENTITY_A}/history?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(60))}`,
    `/api/v1/entities/${ENTITY_A}/pattern-of-life?from=${encodeURIComponent(iso(0))}&to=${encodeURIComponent(iso(60))}`,
  ]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `${url} should be 401 without a token`);
  }
});

test("SEC-003: history routes reject a Viewer token with 403", async () => {
  const testAuth = await createTestAuth();
  const viewerApp = buildApp({ db, auth: testAuth.authOptions, logger: false });
  await viewerApp.ready();
  const viewerHeader = await testAuth.authHeader({ sub: "viewer-1", roles: ["Viewer"] });

  const res = await viewerApp.inject({
    method: "GET",
    url: "/api/v1/entities/history/coverage",
    headers: viewerHeader,
  });
  assert.equal(res.statusCode, 403);
  await viewerApp.close();
});
