// End-to-end proof of SVC-014/015/016: a real geofence zone in Postgres,
// real Redis for entry/exit state, a real GeofenceCheckJob run through
// processJob (the same function the BullMQ Worker calls per job — see
// queue/worker.ts), a real EMAIL send verified against maildev, and the
// resulting Alert + dispatch_log persisted to real Postgres.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDb } from "@vektor/db";
import { createRedisClient } from "@vektor/redis";
import type { GeofenceCheckJob } from "@vektor/shared";
import { createZone, deleteZone } from "../src/db/geofenceZones.js";
import { getAlert } from "../src/db/alerts.js";
import { processJob } from "../src/queue/worker.js";
import { EwmaAnomalyDetector } from "../src/anomaly/ewmaDetector.js";
import { createEmailSender, createSmtpTransport, createWebhookSender, createTwilioSmsSender } from "../src/dispatch/channels.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:16379";
const MAILDEV_SMTP_URL = process.env.MAILDEV_SMTP_URL ?? "smtp://localhost:1025";
const MAILDEV_API_URL = process.env.MAILDEV_API_URL ?? "http://localhost:1080";

const SQUARE: [number, number][] = [
  [9.9, 49.9],
  [10.1, 49.9],
  [10.1, 50.1],
  [9.9, 50.1],
  [9.9, 49.9],
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(150);
  }
}

test("processJob: entering an EMAIL-notifying zone creates a GEOFENCE alert and actually sends the email", async (t) => {
  const db = createDb(DATABASE_URL);
  const redis = createRedisClient(REDIS_URL);
  t.after(() => redis.disconnect());
  t.after(() => db.$client.end());

  const entityId = randomUUID();
  const to = `worker-test-${entityId}@vektor.local`;
  const zoneId = await createZone(db, {
    name: `test-email-zone-${entityId}`,
    trigger: "ENTRY",
    severity: "HIGH",
    affiliation_filter: null,
    channels: ["IN_APP", "EMAIL"],
    notify: { emails: [to], phones: [], webhook_urls: [] },
    polygon: SQUARE,
  });

  const senders = {
    sendEmail: createEmailSender(createSmtpTransport(MAILDEV_SMTP_URL), "alerts@vektor.local"),
    sendSms: createTwilioSmsSender({ baseUrl: "http://localhost:1", accountSid: "x", authToken: "x", fromNumber: "x" }),
    sendWebhook: createWebhookSender(),
  };

  let firedAlertId: string | undefined;
  try {
    const job: GeofenceCheckJob = {
      entity_id: entityId,
      affiliation: "HOSTILE",
      position: { lat: 50.0, lon: 10.0, alt_m: 100, mgrs: "", accuracy_m: 5 },
      speed_kmh: 40,
      heading_deg: 90,
      ts: new Date().toISOString(),
    };

    const result = await processJob(
      { db, redis, senders, detector: new EwmaAnomalyDetector(), onAlert: (id) => (firedAlertId = id) },
      job,
    );
    assert.equal(result.alertsFired, 1);
    assert.ok(firedAlertId);

    const alert = await getAlert(db, firedAlertId!);
    assert.equal(alert?.type, "GEOFENCE");
    assert.equal(alert?.entity_id, entityId);
    assert.equal(alert?.severity, "HIGH");
    const dispatchLog = alert?.dispatch_log as Array<{ channel: string; delivered: boolean }>;
    assert.ok(dispatchLog.some((d) => d.channel === "IN_APP" && d.delivered));
    assert.ok(dispatchLog.some((d) => d.channel === "EMAIL" && d.delivered));

    const received = await waitFor(async () => {
      const res = await fetch(`${MAILDEV_API_URL}/api/email`);
      const emails = (await res.json()) as Array<{ to: Array<{ address: string }> }>;
      return emails.find((e) => e.to.some((t) => t.address === to));
    }, 5000);
    assert.ok(received);
  } finally {
    await deleteZone(db, zoneId);
    await redis.del(`alert-svc:entity-zones:${entityId}`);
  }
});

test("processJob: a sudden speed spike creates an ANOMALY alert even with no geofence involved", async (t) => {
  const db = createDb(DATABASE_URL);
  const redis = createRedisClient(REDIS_URL);
  t.after(() => redis.disconnect());
  t.after(() => db.$client.end());

  const entityId = randomUUID();
  const senders = {
    sendEmail: createEmailSender(createSmtpTransport(MAILDEV_SMTP_URL), "alerts@vektor.local"),
    sendSms: createTwilioSmsSender({ baseUrl: "http://localhost:1", accountSid: "x", authToken: "x", fromNumber: "x" }),
    sendWebhook: createWebhookSender(),
  };
  const detector = new EwmaAnomalyDetector();
  const alertIds: string[] = [];

  try {
    const basePosition = { lat: -10, lon: -70, alt_m: 0, mgrs: "", accuracy_m: 5 }; // well outside SQUARE, no geofence noise
    for (let i = 0; i < 15; i++) {
      await processJob(
        { db, redis, senders, detector, onAlert: (id) => alertIds.push(id) },
        {
          entity_id: entityId,
          affiliation: "NEUTRAL",
          position: basePosition,
          speed_kmh: 60,
          heading_deg: 180,
          ts: new Date().toISOString(),
        },
      );
    }
    assert.equal(alertIds.length, 0); // steady speed, no anomaly yet

    const result = await processJob(
      { db, redis, senders, detector, onAlert: (id) => alertIds.push(id) },
      {
        entity_id: entityId,
        affiliation: "NEUTRAL",
        position: basePosition,
        speed_kmh: 900,
        heading_deg: 180,
        ts: new Date().toISOString(),
      },
    );
    assert.equal(result.alertsFired, 1);
    assert.equal(alertIds.length, 1);

    const alert = await getAlert(db, alertIds[0]!);
    assert.equal(alert?.type, "ANOMALY");
  } finally {
    await redis.del(`alert-svc:entity-zones:${entityId}`);
  }
});
