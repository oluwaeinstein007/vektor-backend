// End-to-end SVC-020/REQ-7.2: a real due cron schedule in Postgres ->
// runScheduledDispatchTick generates a real PDF (real headless Chrome) ->
// emails it via real SMTP (maildev) with a real attachment -> verified via
// maildev's REST API, and last_run_at is advanced so the same tick doesn't
// re-fire immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, reportSchedules, reports } from "@vektor/db";
import { runScheduledDispatchTick, createMailer } from "../src/schedule/scheduler.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:vektor@localhost:5433/vektor";
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
    await sleep(200);
  }
}

test("runScheduledDispatchTick: a due schedule generates and emails a real report, then stops re-firing", async (t) => {
  const db = createDb(DATABASE_URL);
  t.after(() => db.$client.end());
  const dir = await mkdtemp(join(tmpdir(), "vektor-reports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const to = `sched-test-${randomUUID()}@vektor.local`;
  // Daily, not every-minute: this test's real PDF generation + real SMTP
  // send takes several seconds, and an every-minute cron risks crossing a
  // real minute boundary mid-test — found 2026-08-25 when the "must not
  // re-fire immediately" assertion flaked because enough wall-clock time
  // had genuinely passed for the schedule to become due again by cron
  // semantics, not because of a bug in isDue/runScheduledDispatchTick.
  const [schedule] = await db
    .insert(reportSchedules)
    .values({ cron_expr: "0 0 * * *", format: "PDF", recipients: [to], active: true, last_run_at: null })
    .returning();

  const mailer = createMailer(MAILDEV_SMTP_URL);
  const errors: unknown[] = [];

  try {
    const dispatched = await runScheduledDispatchTick(
      { db, storageDir: dir, mailer, mailFrom: "reports@vektor.local", onError: (id, err) => errors.push(err) },
      new Date(),
    );
    assert.equal(errors.length, 0, `unexpected dispatch errors: ${JSON.stringify(errors)}`);
    assert.equal(dispatched, 1);

    const [reportRow] = await db.select().from(reports).where(eq(reports.schedule_id, schedule!.schedule_id));
    assert.equal(reportRow?.status, "COMPLETE");

    const received = await waitFor(async () => {
      const res = await fetch(`${MAILDEV_API_URL}/api/email`);
      const emails = (await res.json()) as Array<{ to: Array<{ address: string }>; attachments?: unknown[] }>;
      return emails.find((e) => e.to.some((t) => t.address === to));
    }, 5000);
    assert.ok(received);
    assert.ok((received.attachments?.length ?? 0) >= 1, "the scheduled email should carry the generated report as an attachment");

    const [updatedSchedule] = await db.select().from(reportSchedules).where(eq(reportSchedules.schedule_id, schedule!.schedule_id));
    assert.ok(updatedSchedule?.last_run_at, "last_run_at should be advanced after a successful dispatch");

    // Immediately re-ticking must NOT dispatch again (not yet due again).
    const secondTick = await runScheduledDispatchTick(
      { db, storageDir: dir, mailer, mailFrom: "reports@vektor.local" },
      new Date(),
    );
    assert.equal(secondTick, 0);
  } finally {
    await db.delete(reports).where(eq(reports.schedule_id, schedule!.schedule_id));
    await db.delete(reportSchedules).where(eq(reportSchedules.schedule_id, schedule!.schedule_id));
  }
});
