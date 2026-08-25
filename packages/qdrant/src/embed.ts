// ML-008 — BGE-M3 embeddings via @xenova/transformers (Transformers.js),
// running the model's ONNX export in-process in Node. No Python, no GPU
// required: this is the TypeScript-first alternative to a Python embedding
// service (§10.4 explicitly picks this over e.g. a sentence-transformers
// microservice specifically to keep the TS↔Python boundary at gRPC-only).
//
// The pipeline is loaded lazily and cached as a module-level singleton, not
// constructed per call — same reasoning as llm-cloud-svc's vLLM engine and
// cv-inference-svc's onnxruntime session: model load is the expensive part
// and must happen once per process, not once per request.
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

export const EMBEDDING_DIM = 1024; // BGE-M3's native output width

let _pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!_pipelinePromise) {
    _pipelinePromise = pipeline("feature-extraction", "Xenova/bge-m3", {
      quantized: true,
    }) as Promise<FeatureExtractionPipeline>;
  }
  return _pipelinePromise;
}

/**
 * Embeds a single string into a normalized 1024-dim BGE-M3 vector. Mean
 * pooling + L2 normalization matches BGE-M3's documented inference recipe
 * (cosine similarity over normalized vectors), which is also what Qdrant's
 * "Cosine" distance metric expects on the collection this writes into.
 */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

/**
 * Batched form — embeds each input independently (Transformers.js's JS
 * pipeline API doesn't expose true batched inference the way a Python
 * sentence-transformers call would), but reuses the one loaded pipeline
 * instance rather than re-resolving getPipeline() per call.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const extractor = await getPipeline();
  const results: number[][] = [];
  for (const text of texts) {
    const output = await extractor(text, { pooling: "mean", normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
}
