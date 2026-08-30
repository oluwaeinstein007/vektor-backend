// A browser-based field-pwa client (an operator's own phone) can't publish
// to MQTT directly the way SVC-003's IoT devices do — this is ingest-svc's
// first-ever HTTP surface, an HTTP equivalent of mqttAdapter.ts's
// republish-as-IotTelemetryEvent path rather than a new Kafka topic or a
// new fusion domain. The wire payload matches FieldPhoneTelemetryPayload
// (vektor-proto), the phone-sourced counterpart to sensor-feeds.ts's
// MavlinkTelemetryPayload — both are recognized by fusion-svc's fromIot()
// via payload.device_class, so no fusion-svc change is needed for the
// topic/domain wiring itself, only for recognizing this new payload shape.
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { IotTelemetryEvent, FieldPhoneTelemetryPayload } from "@vektor/shared";

const FieldTelemetryBody = z.object({
  device_id: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  alt_m: z.number(),
  gps_accuracy_m: z.number().nonnegative().nullable().default(null),
  heading_deg: z.number().min(0).max(360).nullable().default(null),
  pitch_deg: z.number().min(-90).max(90).nullable().default(null),
  roll_deg: z.number().min(-180).max(180).nullable().default(null),
  battery_pct: z.number().min(0).max(100).nullable().default(null),
  sensor_ts: z.string().datetime().optional(),
});

const ErrorResponse = z.object({ error: z.string() });
const AcceptedResponse = z.object({ status: z.literal("accepted"), event_id: z.string().uuid() });

export interface FieldIngestAppOptions {
  producer: Producer;
  env: VektorEnv;
  /**
   * One shared secret for every field-pwa device — a deliberate stopgap,
   * not per-device keys or full Keycloak auth. This endpoint only gates
   * writes (publishing telemetry) on what's meant to be a local/demo
   * network, never reads, so the blast radius of a leaked secret is "someone
   * can inject a fake friendly track," not a data exposure. Upgrade to
   * per-device keys before this is ever reachable outside a trusted network.
   */
  deviceSharedSecret: string;
  onPublished?: (event: IotTelemetryEvent) => void;
  logger?: boolean;
}

function requireDeviceKey(secret: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers["x-vektor-device-key"] !== secret) {
      await reply.code(401).send({ error: "missing or invalid X-Vektor-Device-Key" });
    }
  };
}

export function buildFieldIngestApp(options: FieldIngestAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(cors, { origin: true });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post(
    "/api/v1/field/telemetry",
    {
      preHandler: requireDeviceKey(options.deviceSharedSecret),
      schema: { body: FieldTelemetryBody, response: { 202: AcceptedResponse, 400: ErrorResponse, 401: ErrorResponse } },
    },
    async (request, reply) => {
      const now = new Date();
      const body = request.body;

      const payload: FieldPhoneTelemetryPayload = {
        device_class: "phone",
        lat: body.lat,
        lon: body.lon,
        alt_m: body.alt_m,
        gps_accuracy_m: body.gps_accuracy_m,
        heading_deg: body.heading_deg,
        pitch_deg: body.pitch_deg,
        roll_deg: body.roll_deg,
        battery_pct: body.battery_pct,
      };
      FieldPhoneTelemetryPayload.parse(payload);

      const event: IotTelemetryEvent = {
        event_id: randomUUID(),
        sensor_id: body.device_id,
        // Synthetic label — this event doesn't arrive over real MQTT, but
        // IotTelemetryEvent.mqtt_topic is required and this is the closest
        // honest description of where it came from.
        mqtt_topic: `field-pwa/${body.device_id}`,
        payload,
        sensor_ts: body.sensor_ts ?? now.toISOString(),
        kafka_ts: now.toISOString(),
      };

      try {
        assertValidSensorTs(event.sensor_ts, event.sensor_id, now);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid sensor_ts" });
      }
      IotTelemetryEvent.parse(event);

      await options.producer.send({
        topic: topicName(options.env, "iot", "telemetry"),
        messages: [{ key: event.sensor_id, value: JSON.stringify(event) }],
      });

      options.onPublished?.(event);
      return reply.code(202).send({ status: "accepted" as const, event_id: event.event_id });
    },
  );

  return app;
}
