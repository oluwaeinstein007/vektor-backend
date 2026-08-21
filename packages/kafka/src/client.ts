import { Kafka, type KafkaConfig } from "kafkajs";

/**
 * Every service builds its Kafka client through this factory rather than
 * calling `new Kafka(...)` directly, so broker config/TLS/SASL stay in one
 * place instead of drifting per service.
 */
export function createKafkaClient(config: KafkaConfig): Kafka {
  return new Kafka(config);
}
