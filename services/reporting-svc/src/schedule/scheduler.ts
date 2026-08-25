// SVC-020 — REQ-7.2: "Scheduled report dispatch ... delivered on configured
// cron schedule." A real cron expression parsed by cron-parser (the same
// library BullMQ itself uses internally for repeatable jobs), not a fixed
// setInterval standing in for "cron" — each schedule's actual next-fire
// time is computed from its own expression.
// cron-parser is CJS-only (no ESM named-export interop under this repo's
// NodeNext + "type":"module" config) — same pitfall category as
// mgrs/ioredis; fix is the default-import-then-destructure form, not the
// named import TS's own .d.ts otherwise suggests is fine.
import cronParserPkg from "cron-parser";
const { parseExpression } = cronParserPkg;
import { eq } from "drizzle-orm";
import nodemailer, { type Transporter } from "nodemailer";
import { reportSchedules, type VektorDb } from "@vektor/db";
import type { ReportFormat } from "@vektor/shared";
import { createPendingReport } from "../db/reports.js";
import { generateReport } from "../generate/orchestrator.js";

export interface SchedulerDeps {
  db: VektorDb;
  storageDir: string;
  mailer: Transporter;
  mailFrom: string;
  onDelivered?: (scheduleId: string, reportId: string) => void;
  onError?: (scheduleId: string, err: unknown) => void;
}

export function isDue(cronExpr: string, lastRunAt: Date | null, now: Date): boolean {
  // Due if the schedule has never run, or if a scheduled fire time exists
  // between the last run and now (cron-parser's `next()` after lastRunAt
  // being <= now is exactly that check).
  const from = lastRunAt ?? new Date(0);
  const interval = parseExpression(cronExpr, { currentDate: from });
  const next = interval.next().toDate();
  return next.getTime() <= now.getTime();
}

async function deliverToRecipients(
  mailer: Transporter,
  mailFrom: string,
  recipients: string[],
  format: ReportFormat,
  filePath: string,
): Promise<void> {
  for (const to of recipients) {
    await mailer.sendMail({
      from: mailFrom,
      to,
      subject: `VEKTOR Situation Report (${format})`,
      text: "Attached is your scheduled VEKTOR situation report.",
      attachments: [{ path: filePath }],
    });
  }
}

/** One tick: checks every active schedule and fires the ones that are due. Called from a setInterval in index.ts and directly from tests. */
export async function runScheduledDispatchTick(deps: SchedulerDeps, now: Date = new Date()): Promise<number> {
  const schedules = await deps.db.select().from(reportSchedules).where(eq(reportSchedules.active, true));
  let dispatched = 0;

  for (const schedule of schedules) {
    if (!isDue(schedule.cron_expr, schedule.last_run_at, now)) continue;

    try {
      const format = schedule.format as ReportFormat;
      const report = await createPendingReport(deps.db, format, schedule.schedule_id);
      const filePath = await generateReport(deps.db, report.report_id, format, deps.storageDir);
      const recipients = schedule.recipients as string[];
      await deliverToRecipients(deps.mailer, deps.mailFrom, recipients, format, filePath);

      await deps.db.update(reportSchedules).set({ last_run_at: now }).where(eq(reportSchedules.schedule_id, schedule.schedule_id));
      deps.onDelivered?.(schedule.schedule_id, report.report_id);
      dispatched++;
    } catch (err) {
      deps.onError?.(schedule.schedule_id, err);
    }
  }

  return dispatched;
}

export function createMailer(smtpUrl: string): Transporter {
  return nodemailer.createTransport(smtpUrl);
}
