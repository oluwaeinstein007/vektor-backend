// ML-009's RAG retrieval half — wraps @vektor/qdrant's searchDoctrine and
// flattens the hits into the plain-text doctrine_context string
// COARequest carries. Kept as its own function (rather than inlined in
// generateCoa.ts) so it's independently testable against a real Qdrant
// instance without needing the rest of the pipeline.
import type { QdrantClient } from "@vektor/qdrant";
import { searchDoctrine } from "@vektor/qdrant";

export async function retrieveDoctrineContext(client: QdrantClient, query: string, topK = 5): Promise<string> {
  const hits = await searchDoctrine(client, query, topK);
  if (hits.length === 0) return "";
  return hits.map((h) => `[${h.source}] ${h.text}`).join("\n\n");
}
