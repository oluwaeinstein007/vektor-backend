# coa-svc

Phase 4 (Decision Support): ML-008 (Qdrant doctrine ingestion + BGE-M3 embeddings, via `@vektor/qdrant`), ML-009 (situation context builder + RAG retrieval), ML-010 (gRPC call to `llm-cloud-svc` + Zod output validation), ML-011 (edge COA via `node-llama-cpp`), SVC-012 (Target Workbench threat scoring), SVC-013 (COA approval workflow + audit-svc write).

## Data flow

```
POST /api/v1/coa/generate { target_entity_id }
  → src/threat/scoring.ts        (score the target — SVC-012's documented weighted-sum algorithm)
  → src/context/buildSituation.ts (assemble + sanitize situation JSON — Pitfall 4)
  → src/context/retrieveDoctrine.ts (RAG: @vektor/qdrant's BGE-M3 embed + Qdrant search)
  → src/llm/cloudClient.ts OR src/llm/edgeClient.ts (gRPC to llm-cloud-svc, or local node-llama-cpp)
  → Zod-validated COAOption[] (Pitfall 4's hard gate + R-002's confidence threshold)
  → src/db/coaQueries.ts          (persist to `coas`)

POST /api/v1/coa/:coa_id/approve|reject
  → src/db/coaQueries.ts::decideCoa
  → src/audit/client.ts           (REST write to audit-svc — SVC-013)
```

## Cloud vs. edge mode

Set `VEKTOR_COA_MODE=cloud` (default) or `edge`. Cloud mode requires `LLM_CLOUD_SVC_ADDRESS` (a running `llm-cloud-svc`, gRPC, default `localhost:50051`). Edge mode requires `VEKTOR_EDGE_MODEL_PATH` pointing at a local GGUF file (production target: Mistral 7B Q4_K_M per §10.3; `tests/fixtures/qwen2.5-0.5b-instruct-q4_k_m.gguf` is the much smaller real model this package's own tests run against — see that directory's README).

## Scope notes

- **No REST contract for `POST /api/v1/coa/generate` or `GET /api/v1/target-workbench/ranking` exists in `07-data-api.md`** — Epic 4 only specifies the retrieve/approve/reject endpoints. Both were added here since something has to trigger generation and back the Target Workbench list; see each route file's header comment.
- **Threat scoring (SVC-012) is a fixed, documented weighted sum** (`src/threat/scoring.ts`), not a model — REQ-4.1's "algorithm documented and auditable" is satisfied by every score's `factors` breakdown being returned alongside the total, not just internally computed.
- **`entities`/`blue_force_assets` are read directly via Drizzle**, not proxied through geospatial-svc/fusion-svc's REST APIs — this mirrors the existing precedent of multiple TS services sharing direct typed access to these tables. **No-strike zones are the one exception**: their polygon geometry only fusion-svc knows how to extract (see `packages/db/src/schema/blueForce.ts`), so `context/fetchNoStrikeZones.ts` fetches the already-mapped wire shape over REST instead.
- **`llm-cloud-svc`'s actual vLLM inference is unverified in this sandbox** (no GPU; `vllm` wasn't installable within a reasonable time budget) — see that service's `server.py` module docstring. Everything on this side of the gRPC boundary (the call itself, response validation, confidence-threshold gating) has real test coverage against a real gRPC server (`tests/cloudClient.test.ts`, `tests/generateCoa.test.ts`).

## Local development

Needs the same Postgres/Kafka/Redis as fusion-svc (see its README) plus Qdrant:

```bash
docker run -d --name vektor-qdrant -p 16333:6333 -p 16334:6334 qdrant/qdrant:latest

pnpm build
pnpm ingest-doctrine   # embeds doctrine/*.md into Qdrant — run once, or after editing a doctrine file

DATABASE_URL=postgres://postgres:vektor@localhost:5433/vektor \
QDRANT_URL=http://localhost:16333 \
AUDIT_SVC_URL=http://localhost:3009 \
FUSION_SVC_URL=http://localhost:3007 \
  pnpm start
```
