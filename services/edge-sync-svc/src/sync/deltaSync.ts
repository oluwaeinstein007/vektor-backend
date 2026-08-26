// EDGE-006: resumes from THIS edge node's own last-applied offset (stored
// in local-store.ts), not wherever Kafka's own consumer-group commit
// happens to sit. Two reasons that distinction matters here specifically:
// (1) a Tactical Edge Node can be offline for up to 72h (§11.1) — well past
// most brokers' `offsets.retention.minutes` in a degraded/rebuilt cluster
// scenario — so the group's committed position isn't a safe thing to trust
// blindly; (2) every eachMessage call is offset-gated against the local
// store before being applied, which makes reconnect idempotent by
// construction: whether `consumer.seek()` lands exactly on the first
// unprocessed offset or a message or two early (a known kafkajs quirk when
// seeking immediately after `run()`), already-applied messages are just
// skipped rather than double-applied.
import type { Consumer, Kafka } from "kafkajs";
import type { LocalStore } from "../db/localStore.js";
import type { EntityUpsertedMessage } from "./types.js";

export interface DeltaSyncOptions {
  kafka: Kafka;
  groupId: string;
  topic: string;
  store: LocalStore;
  onApplied?: (msg: EntityUpsertedMessage) => void;
}

export interface DeltaSyncHandle {
  consumer: Consumer;
  stop(): Promise<void>;
}

export async function startDeltaSync(opts: DeltaSyncOptions): Promise<DeltaSyncHandle> {
  const { kafka, groupId, topic, store, onApplied } = opts;

  const admin = kafka.admin();
  await admin.connect();
  const metadata = await admin.fetchTopicMetadata({ topics: [topic] });
  const partitions = (metadata.topics[0]?.partitions ?? []).map((p) => p.partitionId);
  await admin.disconnect();

  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic: msgTopic, partition, message }) => {
      if (!message.value) return;
      const offset = BigInt(message.offset);
      const applied = store.getOffset(msgTopic, partition);
      if (applied !== null && offset <= applied) return; // already synced this one — see header comment

      const payload = JSON.parse(message.value.toString()) as EntityUpsertedMessage;
      store.applyEntityUpsert(payload.entity_id, payload.entity, payload.ts);
      store.setOffset(msgTopic, partition, offset);
      onApplied?.(payload);
    },
  });

  for (const partition of partitions) {
    const applied = store.getOffset(topic, partition);
    if (applied !== null) {
      consumer.seek({ topic, partition, offset: (applied + 1n).toString() });
    }
  }

  return {
    consumer,
    async stop() {
      await consumer.disconnect();
    },
  };
}
