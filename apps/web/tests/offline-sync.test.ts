// fake-indexeddb is a real, spec-compliant IndexedDB implementation (used
// by browser vendors' own conformance suites) standing in for the browser's
// engine, which doesn't exist under plain `node --test` — this is the same
// class of substitution as this project's other "real protocol, stand-in
// endpoint" tests (Twilio's REST shape in alert-svc, vLLM's gRPC surface in
// llm-cloud-svc), not a mock of this file's own queue logic. The one thing
// it can't stand in for is the actual browser's online/offline event
// timing and a real fetch() against a real server across a real network
// state flip — that's verified separately with a real headless browser
// (see the session notes — no committed browser-driven spec exists yet for
// this dashboard, same as FE-002/FE-003's original verification).
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  openSyncDb,
  queuePendingAction,
  listPendingActions,
  removePendingAction,
  flushPendingActions,
  type PendingAction,
} from "../src/lib/offline-sync.ts";

function action(alertId: string): PendingAction {
  return { kind: "alert-ack", alert_id: alertId, action: "ACKNOWLEDGE", operator_id: "op-1", client_ts: new Date().toISOString() };
}

function startStandIn(behavior: (body: unknown) => number): Promise<{ server: Server; url: string; received: unknown[] }> {
  const received: unknown[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : null;
        received.push(body);
        res.writeHead(behavior(body), { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, received });
    });
  });
}

test("queue -> list -> remove round-trips a pending action", async (t) => {
  const db = await openSyncDb();
  t.after(async () => {
    await db.clear("pending-actions");
    db.close();
  });

  const id = await queuePendingAction(db, action("11111111-1111-1111-1111-111111111111"));

  const rows = await listPendingActions(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.alert_id, "11111111-1111-1111-1111-111111111111");

  await removePendingAction(db, id);
  assert.equal((await listPendingActions(db)).length, 0);
});

test("flushPendingActions drains everything that succeeds and stops at the first failure, preserving order", async (t) => {
  const db = await openSyncDb();
  t.after(async () => {
    await db.clear("pending-actions");
    db.close();
  });

  await queuePendingAction(db, action("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
  await queuePendingAction(db, action("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"));
  await queuePendingAction(db, action("cccccccc-cccc-cccc-cccc-cccccccccccc"));

  let callCount = 0;
  const standIn = await startStandIn(() => {
    callCount += 1;
    return callCount === 2 ? 500 : 202; // second action fails
  });
  t.after(() => standIn.server.close());

  const result = await flushPendingActions(db, standIn.url);

  assert.equal(result.synced, 1); // only the first one made it before the failure stopped the drain
  assert.equal(result.remaining, 2);

  const remaining = await listPendingActions(db);
  assert.deepEqual(
    remaining.map((r) => r.alert_id),
    ["bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "cccccccc-cccc-cccc-cccc-cccccccccccc"],
  );
});

test("flushPendingActions leaves the queue untouched when the endpoint is entirely unreachable", async (t) => {
  const db = await openSyncDb();
  t.after(async () => {
    await db.clear("pending-actions");
    db.close();
  });

  await queuePendingAction(db, action("dddddddd-dddd-dddd-dddd-dddddddddddd"));

  const result = await flushPendingActions(db, "http://127.0.0.1:1"); // nothing listens on port 1
  assert.equal(result.synced, 0);
  assert.equal(result.remaining, 1);
});
