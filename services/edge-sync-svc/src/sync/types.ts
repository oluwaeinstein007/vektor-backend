import type { Entity } from "@vektor/shared";

// Mirrors fusion-svc's kafka/entityProducer.ts EntityUpsertedMessage shape —
// not re-declared from a shared package because it's the *wire* shape of
// one specific Kafka topic, not a reusable domain contract; see
// vektor-build-conventions on schema duplication for the line this draws.
export interface EntityUpsertedMessage {
  entity_id: string;
  entity: Entity | null;
  ts: string;
}
