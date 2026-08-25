import { randomUUID } from "node:crypto";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { embed } from "./embed.js";
import { chunkDoctrine } from "./chunk.js";
import { EMBEDDING_DIM } from "./embed.js";

export const DOCTRINE_COLLECTION = "doctrine";

export interface DoctrineHit {
  text: string;
  source: string;
  chunk_index: number;
  score: number;
}

/**
 * Creates the doctrine collection if it doesn't already exist. Idempotent —
 * safe to call at the top of every ingestion run and every service startup,
 * matching the pattern packages/kafka's admin().createTopics() already
 * established for "the thing that owns a topic/collection ensures it
 * exists rather than requiring a separate provisioning step".
 */
export async function ensureDoctrineCollection(client: QdrantClient): Promise<void> {
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === DOCTRINE_COLLECTION);
  if (exists) return;

  await client.createCollection(DOCTRINE_COLLECTION, {
    vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
  });
}

/**
 * Chunks a doctrine source document and upserts every chunk as its own
 * embedded point — ML-008's ingestion path. `source` is a stable document
 * identifier (e.g. the source filename); re-ingesting the same source
 * overwrites its old chunks by deleting them first, so a document that
 * shrinks doesn't leave stale trailing chunks behind.
 */
export async function ingestDoctrineDocument(
  client: QdrantClient,
  source: string,
  text: string,
): Promise<number> {
  await client.delete(DOCTRINE_COLLECTION, {
    filter: { must: [{ key: "source", match: { value: source } }] },
  });

  const chunks = chunkDoctrine(text);
  if (chunks.length === 0) return 0;

  const points = [];
  for (const chunk of chunks) {
    const vector = await embed(chunk.text);
    points.push({
      id: randomUUID(),
      vector,
      payload: { text: chunk.text, source, chunk_index: chunk.chunk_index },
    });
  }

  await client.upsert(DOCTRINE_COLLECTION, { wait: true, points });
  return points.length;
}

/**
 * RAG retrieval — ML-009. Embeds the query with the same BGE-M3 model used
 * at ingestion time (cosine similarity is only meaningful between vectors
 * from the same model) and returns the top-K doctrine chunks.
 */
export async function searchDoctrine(
  client: QdrantClient,
  queryText: string,
  topK = 5,
): Promise<DoctrineHit[]> {
  const vector = await embed(queryText);
  // QdrantClient.search() was removed in favor of the unified query() API
  // (js-client-rest 1.10+) — `query: vector` with no prefetch/using is the
  // direct equivalent of the old nearest-neighbor search() call.
  const result = await client.query(DOCTRINE_COLLECTION, {
    query: vector,
    limit: topK,
    with_payload: true,
  });

  return result.points.map((hit) => {
    const payload = hit.payload as { text: string; source: string; chunk_index: number };
    return {
      text: payload.text,
      source: payload.source,
      chunk_index: payload.chunk_index,
      score: hit.score,
    };
  });
}
