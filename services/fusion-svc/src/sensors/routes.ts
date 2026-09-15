// REQ-1.8/Epic 8's `POST /api/v1/sensors` (UC-5.1) — same
// fastify-type-provider-zod response-schema-as-REQ-9.1-enforcement pattern
// as blueforce/routes.ts. No auth-svc dependency exists yet to gate this
// SuperAdmin-only per the REQ table, same gap every other route in this
// repo already flags.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SensorRegistration, SensorType } from "@vektor/shared";
import { listSensorRegistrations, upsertSensorRegistration, deleteSensorRegistration } from "./queries.js";
import { toWireSensorRegistration } from "./mappers.js";

const ErrorResponse = z.object({ error: z.string() });
const SensorIdParams = z.object({ id: z.string().min(1) });

const RegisterSensorBody = z.object({
  sensor_id: z.string().min(1),
  sensor_type: SensorType,
  label: z.string().min(1),
  position: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
  coverage_radius_m: z.number().positive(),
});

const sensorRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/sensors",
    { schema: { response: { 200: z.array(SensorRegistration) } } },
    async () => {
      const rows = await listSensorRegistrations(app.db);
      return rows.map(toWireSensorRegistration);
    },
  );

  typedApp.post(
    "/api/v1/sensors",
    { schema: { body: RegisterSensorBody, response: { 200: SensorRegistration } } },
    async (request) => {
      const row = await upsertSensorRegistration(app.db, request.body);
      return toWireSensorRegistration(row);
    },
  );

  typedApp.delete(
    "/api/v1/sensors/:id",
    { schema: { params: SensorIdParams, response: { 204: z.void(), 404: ErrorResponse } } },
    async (request, reply) => {
      const deleted = await deleteSensorRegistration(app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "sensor not found" });
      return reply.code(204).send();
    },
  );
};

export default sensorRoutes;
