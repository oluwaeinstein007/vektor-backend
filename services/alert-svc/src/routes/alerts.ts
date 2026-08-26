// SVC-014/015/016 REST surface — REQ-5.4: alert triage queue
// (acknowledge/escalate/dismiss). Listing/action-logging only; alert
// *creation* only ever happens from queue/worker.ts's geofence/anomaly
// checks, so there's deliberately no POST /alerts here.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { Alert } from "@vektor/shared";
import { listAlerts, applyAlertAction, type AlertActionType } from "../db/alerts.js";

const ErrorResponse = z.object({ error: z.string() });
const AlertIdParams = z.object({ id: z.string().uuid() });

const ActionBody = z.object({
  action: z.enum(["ACKNOWLEDGE", "ESCALATE", "DISMISS"]),
});

function toWireAlert(row: {
  alert_id: string;
  type: string;
  entity_id: string | null;
  severity: string;
  message: string;
  status: string;
  ts: Date | null;
}): Alert {
  return Alert.parse({
    alert_id: row.alert_id,
    type: row.type,
    entity_id: row.entity_id,
    severity: row.severity,
    message: row.message,
    status: row.status,
    ts: (row.ts ?? new Date()).toISOString(),
  });
}

const alertRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // 07-data-api.md §13.1: "All roles" — any authenticated user can view the
  // triage queue (§14.3 SENSITIVE data still requires *auth*, just not a
  // minimum role above that).
  typedApp.get(
    "/api/v1/alerts",
    { preHandler: app.requireRole("all"), schema: { response: { 200: z.array(Alert) } } },
    async () => {
      const rows = await listAlerts(app.db);
      return rows.map(toWireAlert);
    },
  );

  typedApp.post(
    "/api/v1/alerts/:id/actions",
    {
      // §13.1 lists only /ack as Analyst+; ESCALATE/DISMISS are broader than
      // the PRD's literal endpoint but carry the same or higher stakes, so
      // the whole action set is held to the same Analyst+ bar.
      preHandler: app.requireRole("analyst+"),
      schema: { params: AlertIdParams, body: ActionBody, response: { 200: Alert, 404: ErrorResponse } },
    },
    async (request, reply) => {
      // SEC-003 audit fix: operator_id used to be a client-supplied body
      // field (spoofable); it's now the verified JWT subject.
      const row = await applyAlertAction(
        app.db,
        request.params.id,
        request.body.action as AlertActionType,
        request.user!.sub,
      );
      if (!row) return reply.code(404).send({ error: "alert not found" });
      return toWireAlert(row);
    },
  );
};

export default alertRoutes;
