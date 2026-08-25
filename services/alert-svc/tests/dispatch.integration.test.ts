// Real network calls against real local infra for every channel: nodemailer
// -> a real maildev SMTP+REST-API container (confirmed 2026-08-24: its REST
// API lives at /api/email, not the classic maildev's /email); a plain
// http.Server standing in for both WEBHOOK and Twilio's REST API (no local
// Twilio emulator exists and this sandbox has no real account, same "real
// protocol, stand-in endpoint" tradeoff as coa-svc's fake gRPC server for
// llm-cloud-svc). IN_APP has no network call to verify — see channels.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import {
  createEmailSender,
  createSmtpTransport,
  createTwilioSmsSender,
  createWebhookSender,
  dispatchAlert,
} from "../src/dispatch/channels.js";

const MAILDEV_SMTP_URL = process.env.MAILDEV_SMTP_URL ?? "smtp://localhost:1025";
const MAILDEV_API_URL = process.env.MAILDEV_API_URL ?? "http://localhost:1080";

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

test("EMAIL channel: sendMail via nodemailer actually lands in a real SMTP inbox", async () => {
  const to = `test-${randomUUID()}@vektor.local`;
  const send = createEmailSender(createSmtpTransport(MAILDEV_SMTP_URL), "alerts@vektor.local");

  await send(to, { alertId: randomUUID(), severity: "HIGH", message: "test geofence breach" });

  const received = await waitFor(async () => {
    const res = await fetch(`${MAILDEV_API_URL}/api/email`);
    const emails = (await res.json()) as Array<{ to: Array<{ address: string }>; subject: string }>;
    return emails.find((e) => e.to.some((t) => t.address === to));
  }, 5000);

  assert.ok(received);
  assert.match(received.subject, /VEKTOR HIGH/);
});

test("WEBHOOK channel: POSTs real JSON body to a real local HTTP server", async () => {
  const received: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const send = createWebhookSender();
    const alertId = randomUUID();
    await send(`http://localhost:${port}/hook`, { alertId, severity: "CRITICAL", message: "test webhook" });

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { alert_id: alertId, severity: "CRITICAL", message: "test webhook" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("SMS channel: sends a real Basic-Auth form-encoded POST matching Twilio's REST shape", async () => {
  const received: { auth?: string; body?: string } = {};
  const server = http.createServer((req, res) => {
    received.auth = req.headers.authorization;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.body = body;
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ sid: "SM123" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const send = createTwilioSmsSender({
      baseUrl: `http://localhost:${port}`,
      accountSid: "AC_test",
      authToken: "secret_token",
      fromNumber: "+15550000000",
    });
    await send("+15551234567", { alertId: randomUUID(), severity: "LOW", message: "test sms" });

    assert.equal(received.auth, `Basic ${Buffer.from("AC_test:secret_token").toString("base64")}`);
    const params = new URLSearchParams(received.body);
    assert.equal(params.get("To"), "+15551234567");
    assert.equal(params.get("From"), "+15550000000");
    assert.match(params.get("Body") ?? "", /test sms/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dispatchAlert: a failing channel is recorded, not thrown, and doesn't block the others", async () => {
  const results = await dispatchAlert(
    {
      sendEmail: async () => {
        throw new Error("smtp down");
      },
      sendSms: async () => {},
      sendWebhook: async () => {},
    },
    ["EMAIL", "SMS"],
    { emails: ["a@b.com"], phones: ["+1555"], webhook_urls: [] },
    { alertId: randomUUID(), severity: "LOW", message: "m" },
  );

  const email = results.find((r) => r.channel === "EMAIL");
  const sms = results.find((r) => r.channel === "SMS");
  assert.equal(email?.delivered, false);
  assert.match(email?.error ?? "", /smtp down/);
  assert.equal(sms?.delivered, true);
});
