// Real Postgres/PostGIS: inserts a real entity row (via raw SQL, same
// ST_SetSRID pattern the entities.position SRID-0 pitfall requires — see
// vektor-build-conventions memory) and queries it back out through the
// same bbox/time-range path REQ-7.3 uses, then verifies both serializers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDb } from "@vektor/db";
import { queryEntitiesForExport } from "../src/export/query.js";
import { toCsv } from "../src/export/csv.js";
import { toGeoJson } from "../src/export/geojson.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("queryEntitiesForExport + toCsv/toGeoJson round-trip a real inserted entity", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const entityId = randomUUID();
  const now = new Date();
  await db.execute(sql`
    INSERT INTO entities (entity_id, classification, confidence, status, affiliation, source_sensors, position, alt_m, accuracy_m, kinematics, metadata, first_detected, last_updated)
    VALUES (
      ${entityId}, 'Test.Widget', 0.9, 'ACTIVE', 'HOSTILE', ARRAY['test-sensor'],
      ST_SetSRID(ST_MakePoint(10.05, 50.05), 0), 100, 5,
      '{}'::jsonb, '{}'::jsonb, ${now.toISOString()}, ${now.toISOString()}
    )
  `);

  try {
    const from = new Date(now.getTime() - 3_600_000);
    const to = new Date(now.getTime() + 3_600_000);

    const rows = await queryEntitiesForExport(db, {
      from,
      to,
      bbox: { min_lon: 9, min_lat: 49, max_lon: 11, max_lat: 51 },
    });
    const mine = rows.find((r) => r.entity_id === entityId);
    assert.ok(mine, "entity should be found within its own bbox/time window");
    assert.ok(Math.abs(mine.lon! - 10.05) < 1e-6);
    assert.ok(Math.abs(mine.lat! - 50.05) < 1e-6);

    const csv = toCsv(rows);
    assert.ok(csv.includes(entityId));
    assert.ok(csv.startsWith("entity_id,classification,affiliation,status,lon,lat,alt_m,last_updated"));

    const geojson = toGeoJson(rows);
    const feature = geojson.features.find((f) => f.properties.entity_id === entityId);
    assert.ok(feature);
    assert.equal(feature.geometry?.type, "Point");
    assert.ok(Math.abs(feature.geometry!.coordinates[0] - 10.05) < 1e-6);

    // Outside the bbox entirely -> not returned.
    const outsideBbox = await queryEntitiesForExport(db, {
      from,
      to,
      bbox: { min_lon: 100, min_lat: 40, max_lon: 101, max_lat: 41 },
    });
    assert.ok(!outsideBbox.some((r) => r.entity_id === entityId));

    // Outside the time window entirely -> not returned.
    const outsideTime = await queryEntitiesForExport(db, {
      from: new Date(now.getTime() - 100_000_000),
      to: new Date(now.getTime() - 50_000_000),
    });
    assert.ok(!outsideTime.some((r) => r.entity_id === entityId));
  } finally {
    await db.execute(sql`DELETE FROM entities WHERE entity_id = ${entityId}`);
  }
});
