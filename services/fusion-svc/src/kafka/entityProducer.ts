// EDGE-006: the Socket.io gateway (socket/gateway.ts) is fusion-svc's
// low-latency live path, but socket.io never replays anything emitted
// before a client subscribes — exactly the FE-002 timing pitfall documented
// in vektor-build-conventions ("socket.io doesn't replay past-emitted
// events"). A Tactical Edge Node that's been offline for hours needs a
// *durable, replayable* channel to catch up on missed entity state instead,
// which is what Kafka is for. This producer is that channel's write side;
// services/edge-sync-svc is the read side that actually does the replay.
import type { Producer } from "kafkajs";
import { topicName, type VektorEnv } from "@vektor/kafka";
import type { Entity } from "@vektor/shared";

export interface EntityUpsertedMessage {
  entity_id: string;
  entity: Entity | null; // null marks the entity as lost/evicted — see emitEntityLost's caller
  ts: string;
}

export function entityUpsertedTopic(env: VektorEnv): string {
  return topicName(env, "entities", "upserted");
}

export async function publishEntityUpserted(
  producer: Producer,
  env: VektorEnv,
  message: EntityUpsertedMessage,
): Promise<void> {
  await producer.send({
    topic: entityUpsertedTopic(env),
    messages: [
      {
        key: message.entity_id,
        value: JSON.stringify(message),
      },
    ],
  });
}
