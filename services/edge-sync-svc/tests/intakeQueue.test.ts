// EDGE-005's backend half, verified against a real Redis-backed BullMQ
// queue and worker (no mocks) with a real stand-in HTTP server playing
// alert-svc's role — same "real protocol, stand-in endpoint" pattern this
// project already uses for Twilio/vLLM (see vektor-project-overview).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import pino from "pino";
import { createIntakeQueue, createIntakeWorker } from "../src/queue/intakeQueue.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";

function startStandInAlertSvc(): Promise<{ server: Server; url: string; requests: Array<{ path: string; body: unknown }> }> {
  const requests: Array<{ path: string; body: unknown }> = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

test("a queued alert-ack job forwards to alert-svc's real actions endpoint", async (t) => {
  const standIn = await startStandInAlertSvc();
  t.after(() => standIn.server.close());

  // Unique per test run — the default queue name is shared/global, and
  // node:test can run this file concurrently with app.test.ts, which also
  // exercises the intake queue against the same Redis instance.
  const queueName = `edge-sync-intake-test-${randomUUID()}`;
  const queue = createIntakeQueue(REDIS_URL, queueName);
  t.after(() => queue.close());

  const logger = pino({ level: "silent" });
  const worker = createIntakeWorker({ redisUrl: REDIS_URL, alertSvcUrl: standIn.url, logger, queueName });
  t.after(() => worker.close());

  const alertId = randomUUID();
  await queue.add("alert-ack", {
    kind: "alert-ack",
    alert_id: alertId,
    action: "ACKNOWLEDGE",
    operator_id: "field-operator-1",
    client_ts: new Date().toISOString(),
  });

  const deadline = Date.now() + 5000;
  while (standIn.requests.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.equal(standIn.requests.length, 1);
  assert.equal(standIn.requests[0]!.path, `/api/v1/alerts/${alertId}/actions`);
  assert.deepEqual(standIn.requests[0]!.body, { action: "ACKNOWLEDGE", operator_id: "field-operator-1" });
});
