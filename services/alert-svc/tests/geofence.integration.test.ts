// Real Postgres (with the actual geofence_zones table/migration) + real
// Redis (for the entity-zones "previously inside" set) — no mocks, same
// bar as fusion-svc's blueforce tests this mirrors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@vektor/db";
import { createRedisClient } from "@vektor/redis";
import { createZone, deleteZone } from "../src/db/geofenceZones.js";
import { checkGeofenceTransitions } from "../src/geofence/checkZones.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";

// A small square around (10, 50) lon/lat — [lon, lat] ring, first === last.
const SQUARE: [number, number][] = [
  [9.9, 49.9],
  [10.1, 49.9],
  [10.1, 50.1],
  [9.9, 50.1],
  [9.9, 49.9],
];
const INSIDE = { lat: 50.0, lon: 10.0 };
const OUTSIDE = { lat: 60.0, lon: 20.0 };

test("geofence ENTRY/EXIT transitions fire exactly once per real crossing", async (t) => {
  const db = createDb(DATABASE_URL);
  const redis = createRedisClient(REDIS_URL);
  t.after(() => redis.disconnect());
  t.after(() => db.$client.end());

  const entityId = randomUUID();

  const bothZoneId = await createZone(db, {
    name: `test-both-${entityId}`,
    trigger: "BOTH",
    severity: "HIGH",
    affiliation_filter: null,
    channels: ["IN_APP"],
    notify: { emails: [], phones: [], webhook_urls: [] },
    polygon: SQUARE,
  });

  const entryOnlyZoneId = await createZone(db, {
    name: `test-entry-only-${entityId}`,
    trigger: "ENTRY",
    severity: "MEDIUM",
    affiliation_filter: null,
    channels: ["IN_APP"],
    notify: { emails: [], phones: [], webhook_urls: [] },
    polygon: SQUARE,
  });

  try {
    // 1. Entering the zone from outside -> both zones fire ENTRY.
    const enter = await checkGeofenceTransitions(db, redis, entityId, INSIDE, "FRIENDLY");
    assert.equal(enter.length, 2);
    assert.ok(enter.every((tr) => tr.event === "ENTRY"));

    // 2. Staying inside on the next tick -> no transitions at all.
    const stayInside = await checkGeofenceTransitions(db, redis, entityId, INSIDE, "FRIENDLY");
    assert.equal(stayInside.length, 0);

    // 3. Leaving the zone -> only the BOTH-trigger zone fires EXIT; the
    // ENTRY-only zone stays silent per its own trigger config.
    const exit = await checkGeofenceTransitions(db, redis, entityId, OUTSIDE, "FRIENDLY");
    assert.equal(exit.length, 1);
    assert.equal(exit[0]!.event, "EXIT");
    assert.equal(exit[0]!.zone.zone_id, bothZoneId);
  } finally {
    await deleteZone(db, bothZoneId);
    await deleteZone(db, entryOnlyZoneId);
    await redis.del(`alert-svc:entity-zones:${entityId}`);
  }
});

test("geofence affiliation_filter excludes non-matching entities", async (t) => {
  const db = createDb(DATABASE_URL);
  const redis = createRedisClient(REDIS_URL);
  t.after(() => redis.disconnect());
  t.after(() => db.$client.end());

  const entityId = randomUUID();
  const zoneId = await createZone(db, {
    name: `test-hostile-only-${entityId}`,
    trigger: "ENTRY",
    severity: "CRITICAL",
    affiliation_filter: "HOSTILE",
    channels: ["IN_APP"],
    notify: { emails: [], phones: [], webhook_urls: [] },
    polygon: SQUARE,
  });

  try {
    const friendlyEnter = await checkGeofenceTransitions(db, redis, entityId, INSIDE, "FRIENDLY");
    assert.equal(friendlyEnter.length, 0);

    await redis.del(`alert-svc:entity-zones:${entityId}`);
    const hostileEnter = await checkGeofenceTransitions(db, redis, entityId, INSIDE, "HOSTILE");
    assert.equal(hostileEnter.length, 1);
  } finally {
    await deleteZone(db, zoneId);
    await redis.del(`alert-svc:entity-zones:${entityId}`);
  }
});
