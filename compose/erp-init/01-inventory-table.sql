-- NW-003 follow-up. `--profile full` brought the ERP stand-in up completely
-- bare: there is no DDL for an `inventory` table anywhere in the seven
-- repos, yet logistics-svc's cdc.integration.test.ts does
-- `INSERT INTO inventory (...)` against it. The table only ever existed on
-- a machine where somebody had created it by hand — the same shape of bug
-- as vektor-proto's gitignored generated code: works locally, fails on any
-- clean stack.
--
-- Columns are derived from the two places that define the contract:
-- logistics-svc/src/cdc/inventoryConsumer.ts's DebeziumInventoryRow (what
-- the consumer expects to read off the wire) and packages/db's
-- inventoryItems (what it writes into VEKTOR's own database).
CREATE TABLE IF NOT EXISTS inventory (
  item_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku               text        NOT NULL UNIQUE,
  name              text        NOT NULL,
  category          text        NOT NULL,
  quantity          real        NOT NULL,
  reorder_threshold real        NOT NULL,
  location          text        NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- REPLICA IDENTITY FULL so a DELETE carries a before-image. Without it
-- Debezium emits `before: null` on deletes, and applyChange() reads
-- before.item_id to decide what to remove — so deletes would silently do
-- nothing. Postgres defaults to REPLICA IDENTITY DEFAULT (primary key only),
-- which is not enough here.
ALTER TABLE inventory REPLICA IDENTITY FULL;
