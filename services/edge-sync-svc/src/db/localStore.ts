// §11.4's "Offline DB: better-sqlite3" budget line — this is that store.
// Two jobs live in the same SQLite file: (1) the per-topic-partition offset
// this edge node has actually applied (not the same thing as Kafka's own
// consumer-group committed offset — see sync/consumer.ts's header comment
// for why this node tracks its own), and (2) the resulting local mirror of
// synced entity state, so a delta-sync test can assert on real applied
// state, not just an offset number moving.
import Database from "better-sqlite3";
import type { Entity } from "@vektor/shared";

export interface LocalStore {
  db: Database.Database;
  getOffset(topic: string, partition: number): bigint | null;
  setOffset(topic: string, partition: number, offset: bigint): void;
  applyEntityUpsert(entityId: string, entity: Entity | null, ts: string): void;
  getEntity(entityId: string): { entity: Entity | null; ts: string } | null;
  countEntities(): number;
  close(): void;
}

export function openLocalStore(path: string): LocalStore {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_offsets (
      topic TEXT NOT NULL,
      partition INTEGER NOT NULL,
      "offset" TEXT NOT NULL,
      PRIMARY KEY (topic, partition)
    );
    CREATE TABLE IF NOT EXISTS entities_mirror (
      entity_id TEXT PRIMARY KEY,
      entity_json TEXT,
      ts TEXT NOT NULL
    );
  `);

  const getOffsetStmt = db.prepare(
    `SELECT "offset" FROM sync_offsets WHERE topic = ? AND partition = ?`,
  );
  const setOffsetStmt = db.prepare(
    `INSERT INTO sync_offsets (topic, partition, "offset") VALUES (?, ?, ?)
     ON CONFLICT(topic, partition) DO UPDATE SET "offset" = excluded."offset"`,
  );
  const upsertEntityStmt = db.prepare(
    `INSERT INTO entities_mirror (entity_id, entity_json, ts) VALUES (?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET entity_json = excluded.entity_json, ts = excluded.ts`,
  );
  const getEntityStmt = db.prepare(`SELECT entity_json, ts FROM entities_mirror WHERE entity_id = ?`);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM entities_mirror`);

  return {
    db,
    getOffset(topic, partition) {
      const row = getOffsetStmt.get(topic, partition) as { offset: string } | undefined;
      return row ? BigInt(row.offset) : null;
    },
    setOffset(topic, partition, offset) {
      setOffsetStmt.run(topic, partition, offset.toString());
    },
    applyEntityUpsert(entityId, entity, ts) {
      upsertEntityStmt.run(entityId, entity ? JSON.stringify(entity) : null, ts);
    },
    getEntity(entityId) {
      const row = getEntityStmt.get(entityId) as { entity_json: string | null; ts: string } | undefined;
      if (!row) return null;
      return { entity: row.entity_json ? (JSON.parse(row.entity_json) as Entity) : null, ts: row.ts };
    },
    countEntities() {
      return (countStmt.get() as { n: number }).n;
    },
    close() {
      db.close();
    },
  };
}
