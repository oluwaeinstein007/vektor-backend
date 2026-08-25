import { QdrantClient } from "@qdrant/js-client-rest";

/**
 * Every service builds its Qdrant client through this factory rather than
 * calling `new QdrantClient(...)` directly — same reasoning as
 * @vektor/db's createDb and @vektor/kafka's createKafkaClient.
 */
export function createQdrantClient(url: string): QdrantClient {
  return new QdrantClient({ url });
}

export type { QdrantClient };
