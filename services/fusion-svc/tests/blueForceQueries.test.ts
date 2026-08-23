import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "@vektor/db";
import {
  upsertBlueForceAsset,
  deleteBlueForceAsset,
  createManualZone,
  deleteNoStrikeZone,
  listNoStrikeZones,
  isInNoStrikeZone,
} from "../src/blueforce/queries.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";

test("upserting a blue-force asset auto-creates a meters-accurate no-strike buffer zone, and updates it in place on re-upsert", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const asset = await upsertBlueForceAsset(db, {
    callsign: `TEST-ALPHA-${Date.now()}`,
    classification: "GroundVehicle.Friendly",
    position: { lat: 10, lon: 20, alt_m: 0 },
    buffer_radius_m: 500,
  });

  // A point ~200m from the asset (well inside the 500m buffer) must be flagged no-strike...
  assert.equal(await isInNoStrikeZone(db, { lat: 10.0018, lon: 20 }), true);
  // ...and a point ~5km away must not be.
  assert.equal(await isInNoStrikeZone(db, { lat: 10.045, lon: 20 }), false);

  // Re-upserting with a shrunk radius should replace (not duplicate) the buffer zone.
  await upsertBlueForceAsset(db, {
    asset_id: asset.asset_id,
    callsign: asset.callsign,
    classification: asset.classification,
    position: { lat: 10, lon: 20, alt_m: 0 },
    buffer_radius_m: 50,
  });

  const zones = await listNoStrikeZones(db);
  const bufferZonesForAsset = zones.filter((z) => z.source_asset_id === asset.asset_id);
  assert.equal(bufferZonesForAsset.length, 1, "re-upsert should update the existing buffer zone, not create a second one");

  // The point that was inside the 500m buffer is now outside the shrunk 50m one.
  assert.equal(await isInNoStrikeZone(db, { lat: 10.0018, lon: 20 }), false);

  for (const zone of bufferZonesForAsset) await deleteNoStrikeZone(db, zone.zone_id);
  await deleteBlueForceAsset(db, asset.asset_id);
});

test("deleting a blue-force asset leaves its buffer zone behind (no cascade)", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const asset = await upsertBlueForceAsset(db, {
    callsign: `TEST-BRAVO-${Date.now()}`,
    classification: "GroundVehicle.Friendly",
    position: { lat: -5, lon: 40, alt_m: 0 },
    buffer_radius_m: 200,
  });
  await deleteBlueForceAsset(db, asset.asset_id);

  assert.equal(await isInNoStrikeZone(db, { lat: -5, lon: 40 }), true, "buffer zone should still exist after asset delete");

  const zones = await listNoStrikeZones(db);
  const leftover = zones.filter((z) => z.source_asset_id === asset.asset_id);
  for (const zone of leftover) await deleteNoStrikeZone(db, zone.zone_id);
});

test("a manually-drawn no-strike zone (analyst-owned, no backing asset) round-trips through ST_AsGeoJSON correctly", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());

  const polygon: [number, number][] = [
    [100, 0],
    [100, 1],
    [101, 1],
    [101, 0],
    [100, 0],
  ];
  const zoneId = await createManualZone(db, { name: "Test Hospital", polygon });

  assert.equal(await isInNoStrikeZone(db, { lat: 0.5, lon: 100.5 }), true);
  assert.equal(await isInNoStrikeZone(db, { lat: 5, lon: 100.5 }), false);

  const zones = await listNoStrikeZones(db);
  const created = zones.find((z) => z.zone_id === zoneId);
  assert.ok(created);
  assert.equal(created.source, "MANUAL");
  assert.equal(created.source_asset_id, null);

  await deleteNoStrikeZone(db, zoneId);
});
