import pino from "pino";
import { createDb } from "@vektor/db";
import { createQdrantClient, ensureDoctrineCollection } from "@vektor/qdrant";
import { buildApp } from "./app.js";
import { createCloudLlmClient } from "./llm/cloudClient.js";
import type { CoaMode } from "./llm/generateCoa.js";

const logger = pino({ name: "coa-svc" });

const DATABASE_URL = process.env.DATABASE_URL;
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const PORT = Number(process.env.PORT ?? 3010);
const AUDIT_SVC_URL = process.env.AUDIT_SVC_URL ?? "http://localhost:3009";
const FUSION_SVC_URL = process.env.FUSION_SVC_URL ?? "http://localhost:3007";
// "cloud" (default) talks to llm-cloud-svc over gRPC; "edge" runs a local
// GGUF model via node-llama-cpp (ML-011) — set for a disconnected/degraded
// edge deployment with no reachable vektor-ml-enclave.
const COA_MODE = (process.env.VEKTOR_COA_MODE ?? "cloud") as "cloud" | "edge";
const LLM_CLOUD_SVC_ADDRESS = process.env.LLM_CLOUD_SVC_ADDRESS ?? "localhost:50051";
const EDGE_MODEL_PATH = process.env.VEKTOR_EDGE_MODEL_PATH;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}
if (COA_MODE === "edge" && !EDGE_MODEL_PATH) {
  throw new Error("VEKTOR_EDGE_MODEL_PATH is required when VEKTOR_COA_MODE=edge");
}

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const qdrant = createQdrantClient(QDRANT_URL);
  await ensureDoctrineCollection(qdrant);

  const mode: CoaMode =
    COA_MODE === "edge"
      ? { kind: "edge", modelPath: EDGE_MODEL_PATH! }
      : { kind: "cloud", llmClient: createCloudLlmClient(LLM_CLOUD_SVC_ADDRESS) };

  const app = buildApp({ db, qdrant, mode, auditSvcUrl: AUDIT_SVC_URL, fusionSvcUrl: FUSION_SVC_URL });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT, mode: mode.kind }, "coa-svc listening");

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, "shutting down");
    await app.close();
    await db.$client.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start coa-svc");
  process.exit(1);
});
