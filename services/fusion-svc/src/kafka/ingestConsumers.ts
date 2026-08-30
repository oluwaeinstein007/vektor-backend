// SVC-007's Kafka half: one consumer group across every domain topic
// fusion-svc fuses, landing each validated message onto its own Redis
// Stream (SVC-007's other half — see @vektor/redis's watermarkWindow.ts,
// which is what actually reads these streams back out in sensor_ts order).
//
// Parsing every message through its Zod schema here is what "rejects
// malformed events at the consumer boundary" (Pitfall 1, VEKTOR-PRD.md §17)
// actually means on the read side — a message whose sensor_ts isn't valid
// ISO 8601, or that's missing a required field, throws inside the schema's
// .parse() and is dropped (logged via onError) rather than corrupting the
// watermark with an unparseable timestamp.
//
// `detection.tracked` (CV tracks) is included for completeness — it's
// windowed like every other domain — but produces no TrackObservation
// downstream (see pipeline/observationMappers.ts's header comment for why).
import type { Consumer } from "kafkajs";
import type { Redis } from "@vektor/redis";
import { publishToStream } from "@vektor/redis";
import { topicName, type VektorEnv } from "@vektor/kafka";
import {
  DetectionEvent,
  AisPositionReport,
  AdsbPositionReport,
  EwRfEmission,
  IotTelemetryEvent,
  type SensorHealth,
} from "@vektor/shared";

export const FUSION_DOMAINS = ["detection", "ais", "adsb", "ewrf", "iot"] as const;
export type FusionDomain = (typeof FUSION_DOMAINS)[number];

const SCHEMAS = {
  detection: DetectionEvent,
  ais: AisPositionReport,
  adsb: AdsbPositionReport,
  ewrf: EwRfEmission,
  iot: IotTelemetryEvent,
} as const;

const TOPIC_ACTIONS: Record<FusionDomain, string> = {
  detection: "tracked",
  ais: "position",
  adsb: "position",
  ewrf: "emission",
  iot: "telemetry",
};

export interface IngestConsumersOptions {
  consumer: Consumer;
  redis: Redis;
  env: VektorEnv;
  /** REQ-1.8: called once per successfully-parsed message so the caller can surface it via sensor:status — every domain schema carries sensor_id/sensor_ts, so this is derivable generically rather than per-domain. */
  onSensorHealth?: (health: SensorHealth) => void;
  onError?: (domain: FusionDomain, err: Error) => void;
}

export function fusionTopic(env: VektorEnv, domain: FusionDomain): string {
  return topicName(env, domain, TOPIC_ACTIONS[domain]);
}

export async function runIngestConsumers(options: IngestConsumersOptions): Promise<void> {
  const topicToDomain = new Map<string, FusionDomain>(FUSION_DOMAINS.map((d) => [fusionTopic(options.env, d), d]));

  await options.consumer.subscribe({ topics: Array.from(topicToDomain.keys()), fromBeginning: false });
  await options.consumer.run({
    eachMessage: async ({ topic, message }) => {
      const domain = topicToDomain.get(topic);
      if (!domain || !message.value) return;

      try {
        const parsed = SCHEMAS[domain].parse(JSON.parse(message.value.toString()));
        await publishToStream(options.redis, domain, parsed.sensor_ts, parsed);
        // No adapter attaches a sequence number yet (SVC-003), so drop_rate
        // can't be measured for real — 0 is the honest default until one does.
        options.onSensorHealth?.({
          sensor_id: parsed.sensor_id,
          status: "ONLINE",
          latency_ms: Math.max(0, Date.now() - Date.parse(parsed.sensor_ts)),
          drop_rate: 0,
          last_heartbeat: new Date().toISOString(),
        });
      } catch (err) {
        options.onError?.(domain, err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
