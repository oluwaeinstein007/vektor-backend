export { createQdrantClient } from "./client.js";
export type { QdrantClient } from "./client.js";
export { embed, embedBatch, EMBEDDING_DIM } from "./embed.js";
export { chunkDoctrine } from "./chunk.js";
export type { DoctrineChunk } from "./chunk.js";
export {
  DOCTRINE_COLLECTION,
  ensureDoctrineCollection,
  ingestDoctrineDocument,
  searchDoctrine,
} from "./doctrine.js";
export type { DoctrineHit } from "./doctrine.js";
