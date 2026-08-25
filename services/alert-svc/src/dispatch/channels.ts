// SVC-016 — REQ-5.3: "Route alerts via in-app queue, email, SMS, and
// configurable webhook." Each channel is a real network call against real
// infra in tests (nodemailer -> a local maildev SMTP+API container for
// email; a plain fetch POST -> a local http server standing in for both
// webhook and Twilio's REST API, since Twilio has no local emulator and
// this sandbox has no real account/credentials — same "real protocol,
// stand-in endpoint" tradeoff coa-svc's tests use for llm-cloud-svc's gRPC
// server). IN_APP has no network call: persisting the Alert row (already
// done by the time dispatch() runs) *is* the in-app queue.
import nodemailer, { type Transporter } from "nodemailer";
import type { AlertChannel, NotifyConfig, AlertSeverity } from "@vektor/shared";

export interface DispatchContext {
  alertId: string;
  severity: AlertSeverity;
  message: string;
}

export interface ChannelResult {
  channel: AlertChannel;
  target: string;
  delivered: boolean;
  error?: string;
}

export interface ChannelSenders {
  sendEmail: (to: string, ctx: DispatchContext) => Promise<void>;
  sendSms: (to: string, ctx: DispatchContext) => Promise<void>;
  sendWebhook: (url: string, ctx: DispatchContext) => Promise<void>;
}

export function createEmailSender(transporter: Transporter, from: string): ChannelSenders["sendEmail"] {
  return async (to, ctx) => {
    await transporter.sendMail({
      from,
      to,
      subject: `[VEKTOR ${ctx.severity}] Alert ${ctx.alertId}`,
      text: ctx.message,
    });
  };
}

export function createSmtpTransport(url: string): Transporter {
  return nodemailer.createTransport(url);
}

/**
 * Twilio's REST API shape (POST /2010-04-01/Accounts/{sid}/Messages.json,
 * form-encoded, Basic Auth) with the base URL injectable so tests can point
 * it at a local stand-in server instead of api.twilio.com — this endpoint
 * and the account credentials are genuinely never exercised against a real
 * Twilio account in this sandbox (no network egress, no account), same
 * "real wiring, unverified against the real vendor" caveat as
 * vektor-ml/llm-cloud-svc's vLLM engine construction.
 */
export function createTwilioSmsSender(options: {
  baseUrl: string;
  accountSid: string;
  authToken: string;
  fromNumber: string;
}): ChannelSenders["sendSms"] {
  return async (to, ctx) => {
    const body = new URLSearchParams({
      To: to,
      From: options.fromNumber,
      Body: `[VEKTOR ${ctx.severity}] ${ctx.message}`,
    });
    const auth = Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64");
    const res = await fetch(`${options.baseUrl}/2010-04-01/Accounts/${options.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Twilio send failed: ${res.status} ${await res.text()}`);
    }
  };
}

export function createWebhookSender(): ChannelSenders["sendWebhook"] {
  return async (url, ctx) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alert_id: ctx.alertId, severity: ctx.severity, message: ctx.message }),
    });
    if (!res.ok) {
      throw new Error(`Webhook POST failed: ${res.status} ${await res.text()}`);
    }
  };
}

export async function dispatchAlert(
  senders: ChannelSenders,
  channels: AlertChannel[],
  notify: NotifyConfig,
  ctx: DispatchContext,
): Promise<ChannelResult[]> {
  const results: ChannelResult[] = [];

  const attempts: Array<{ channel: AlertChannel; target: string; send: () => Promise<void> }> = [];
  if (channels.includes("IN_APP")) {
    attempts.push({ channel: "IN_APP", target: "queue", send: async () => {} });
  }
  if (channels.includes("EMAIL")) {
    for (const to of notify.emails) attempts.push({ channel: "EMAIL", target: to, send: () => senders.sendEmail(to, ctx) });
  }
  if (channels.includes("SMS")) {
    for (const to of notify.phones) attempts.push({ channel: "SMS", target: to, send: () => senders.sendSms(to, ctx) });
  }
  if (channels.includes("WEBHOOK")) {
    for (const url of notify.webhook_urls)
      attempts.push({ channel: "WEBHOOK", target: url, send: () => senders.sendWebhook(url, ctx) });
  }

  for (const attempt of attempts) {
    try {
      await attempt.send();
      results.push({ channel: attempt.channel, target: attempt.target, delivered: true });
    } catch (err) {
      results.push({
        channel: attempt.channel,
        target: attempt.target,
        delivered: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
