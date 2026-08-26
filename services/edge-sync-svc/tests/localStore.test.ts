import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalStore } from "../src/db/localStore.js";

test("offset store round-trips and upserts per topic/partition", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "edge-sync-store-"));
  const store = openLocalStore(join(dir, "test.sqlite3"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(store.getOffset("topic-a", 0), null);

  store.setOffset("topic-a", 0, 5n);
  assert.equal(store.getOffset("topic-a", 0), 5n);

  // A large offset must survive as a real bigint, not silently lose
  // precision to JS's default number type (this is why the column is TEXT).
  store.setOffset("topic-a", 0, 9007199254740993n);
  assert.equal(store.getOffset("topic-a", 0), 9007199254740993n);

  // Different partition, same topic — independent.
  store.setOffset("topic-a", 1, 2n);
  assert.equal(store.getOffset("topic-a", 0), 9007199254740993n);
  assert.equal(store.getOffset("topic-a", 1), 2n);
});

test("entity mirror upserts, reads, deletes (lost = null), and counts real applied state", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "edge-sync-store-"));
  const store = openLocalStore(join(dir, "test.sqlite3"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(store.countEntities(), 0);
  assert.equal(store.getEntity("e1"), null);

  const fakeEntity = { entity_id: "e1", classification: "GroundVehicle.Tracked" } as never;
  store.applyEntityUpsert("e1", fakeEntity, "2026-08-25T00:00:00.000Z");
  assert.equal(store.countEntities(), 1);
  assert.deepEqual(store.getEntity("e1")!.entity, fakeEntity);

  // A "lost" message (entity: null) still counts as a synced row — it's the
  // last-known state (evicted), not an absence of state.
  store.applyEntityUpsert("e1", null, "2026-08-25T00:01:00.000Z");
  assert.equal(store.countEntities(), 1);
  assert.equal(store.getEntity("e1")!.entity, null);
});
