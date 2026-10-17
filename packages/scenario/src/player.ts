/**
 * NW-020 — playback: walks the scenario clock and publishes to Kafka.
 *
 * The only impure part of this package. Everything it decides to publish
 * comes from engine.ts; this file is responsible for *when*.
 */
import { createKafkaClient, topicName, type VektorEnv } from "@vektor/kafka";
import type { Producer } from "kafkajs";
import { tick } from "./engine.js";
import { toEvent, type EmittedEvent } from "./emit.js";
import type { Scenario } from "./scenario.js";

export interface PlayOptions {
  scenario: Scenario;
  brokers: string[];
  env: VektorEnv | string;
  /** Scenario seconds per wall-clock second. 60 plays an hour in a minute. */
  speed: number;
  loop: boolean;
  /** How often the clock advances, in wall-clock ms. */
  tickMs: number;
  onBatch?: (events: EmittedEvent[], scenarioT: number) => void;
  signal?: AbortSignal;
}

export interface PlaybackResult {
  published: number;
  loops: number;
  wallMs: number;
}

export async function play(options: PlayOptions): Promise<PlaybackResult> {
  const { scenario, speed, tickMs } = options;
  const kafka = createKafkaClient({ clientId: "vektor-scenario", brokers: options.brokers });
  const producer = kafka.producer();
  await producer.connect();

  const startedWall = Date.now();
  let published = 0;
  let loops = 0;

  try {
    let scenarioT = 0;
    while (!options.signal?.aborted) {
      const nextT = scenarioT + (tickMs / 1000) * speed;
      const states = tick(scenario, scenarioT, Math.min(nextT, scenario.duration_s));

      if (states.length > 0) {
        const byEntity = new Map(scenario.entities.map((e) => [e.id, e]));
        const events: EmittedEvent[] = [];
        for (const state of states) {
          const entity = byEntity.get(state.entityId);
          if (!entity) continue;
          events.push(
            toEvent(entity, state, {
              sensorId: scenario.sensor_id,
              // Wall-clock, NOT scenario time. fusion-svc's event-time
              // watermark and SVC-004's ingest-boundary clock check both
              // compare sensor_ts against now; a scenario-relative stamp
              // would be rejected as a broken sensor clock, or silently
              // held out of the watermark window forever. Positions are
              // deterministic; timestamps are necessarily live. The
              // dry-run path in index.ts is what produces a stable golden
              // file.
              sensorTs: new Date(),
            }),
          );
        }
        await publish(producer, options.env, events);
        published += events.length;
        options.onBatch?.(events, scenarioT);
      }

      scenarioT = nextT;
      if (scenarioT >= scenario.duration_s) {
        loops++;
        if (!options.loop) break;
        scenarioT = 0;
      }

      await sleep(tickMs, options.signal);
    }
  } finally {
    await producer.disconnect();
  }

  return { published, loops, wallMs: Date.now() - startedWall };
}

async function publish(producer: Producer, env: string, events: EmittedEvent[]): Promise<void> {
  // Grouped per topic: one send per topic per tick rather than one per
  // event. At a few thousand entities the per-message round trip, not the
  // simulation, would otherwise become the bottleneck and the player would
  // be measuring itself.
  const byTopic = new Map<string, { key: string; value: string }[]>();
  for (const event of events) {
    const topic = topicName(env as VektorEnv, event.domain, event.action);
    const list = byTopic.get(topic) ?? [];
    list.push({ key: event.key, value: JSON.stringify(event.value) });
    byTopic.set(topic, list);
  }
  await Promise.all(
    [...byTopic].map(([topic, messages]) => producer.send({ topic, messages })),
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
