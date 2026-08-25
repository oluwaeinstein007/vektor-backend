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
  operator_id: z.string().min(1),
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

  typedApp.get("/api/v1/alerts", { schema: { response: { 200: z.array(Alert) } } }, async () => {
    const rows = await listAlerts(app.db);
    return rows.map(toWireAlert);
  });

  typedApp.post(
    "/api/v1/alerts/:id/actions",
    { schema: { params: AlertIdParams, body: ActionBody, response: { 200: Alert, 404: ErrorResponse } } },
    async (request, reply) => {
      const row = await applyAlertAction(
        app.db,
        request.params.id,
        request.body.action as AlertActionType,
        request.body.operator_id,
      );
      if (!row) return reply.code(404).send({ error: "alert not found" });
      return toWireAlert(row);
    },
  );
};

export default alertRoutes;
