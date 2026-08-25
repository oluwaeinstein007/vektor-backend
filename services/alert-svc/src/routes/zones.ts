// SVC-014 REST surface for operator-managed geofence zones — same
// fastify-type-provider-zod response-schema pattern fusion-svc's
// blueforce/routes.ts already established (REQ-9.1 enforcement).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { GeofenceTrigger, AlertSeverity, EntityAffiliation, AlertChannel, NotifyConfig } from "@vektor/shared";
import { createZone, deleteZone, listZones } from "../db/geofenceZones.js";

const ErrorResponse = z.object({ error: z.string() });
const ZoneIdParams = z.object({ id: z.string().uuid() });

const CreateZoneBody = z.object({
  name: z.string().min(1),
  trigger: GeofenceTrigger,
  severity: AlertSeverity,
  affiliation_filter: EntityAffiliation.nullable(),
  channels: z.array(AlertChannel).min(1),
  notify: NotifyConfig,
  polygon: z.array(z.tuple([z.number(), z.number()])).min(4),
  active: z.boolean().optional(),
});

const ZoneSummary = z.object({
  zone_id: z.string().uuid(),
  name: z.string(),
  trigger: z.string(),
  severity: z.string(),
  affiliation_filter: z.string().nullable(),
  channels: z.array(AlertChannel),
  notify: NotifyConfig,
  active: z.boolean(),
  created_at: z.date().or(z.string()),
});

const zoneRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get("/api/v1/geofence-zones", { schema: { response: { 200: z.array(ZoneSummary) } } }, async () => {
    return listZones(app.db);
  });

  typedApp.post(
    "/api/v1/geofence-zones",
    { schema: { body: CreateZoneBody, response: { 200: z.object({ zone_id: z.string().uuid() }) } } },
    async (request) => {
      const zone_id = await createZone(app.db, request.body);
      return { zone_id };
    },
  );

  typedApp.delete(
    "/api/v1/geofence-zones/:id",
    { schema: { params: ZoneIdParams, response: { 204: z.void(), 404: ErrorResponse } } },
    async (request, reply) => {
      const deleted = await deleteZone(app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "zone not found" });
      return reply.code(204).send();
    },
  );
};

export default zoneRoutes;
