// ML-010 — gRPC call to llm-cloud-svc via @vektor/proto's generated stub,
// plus the Zod validation gate Pitfall 4/R-002 require: a malformed or
// low-confidence response is rejected here, before it ever reaches the
// Target Workbench, not left for the frontend to notice. `parseCloudResponse`
// is split out as a pure function (no gRPC involved) so the validation gate
// itself has direct unit coverage, same pattern as llm-cloud-svc's
// _extract_json/_compute_confidence on the Python side of this boundary.
import { z } from "zod";
import { COAOption } from "@vektor/shared";
// `credentials` MUST come from @vektor/shared/llm (re-exported from
// vektor-proto's own @grpc/grpc-js instance), not a direct @grpc/grpc-js
// import — see vektor-proto/src/llm.ts's header comment for why a
// same-version-but-different-instance credentials object fails an
// instanceof check inside LLMServiceClient.
import { LLMServiceClient, credentials } from "@vektor/shared/llm";

// R-002: "confidence threshold blocks low-quality responses." Configurable
// since llm-cloud-svc's confidence is a real signal only once ML-007's
// vLLM engine is actually wired to real hardware — see that service's
// _compute_confidence, which honestly reports 0.0 with no engine attached
// rather than fabricating a score.
export const CONFIDENCE_THRESHOLD = Number(process.env.COA_MIN_CONFIDENCE ?? 0.15);

export class LowConfidenceError extends Error {
  constructor(confidence: number) {
    super(`llm-cloud-svc response confidence ${confidence} is below the ${CONFIDENCE_THRESHOLD} threshold (R-002)`);
    this.name = "LowConfidenceError";
  }
}

export function createCloudLlmClient(address: string): LLMServiceClient {
  return new LLMServiceClient(address, credentials.createInsecure());
}

export interface GenerateCoaCloudParams {
  situation_json: string;
  doctrine_context: string;
  num_options: number;
}

export interface GenerateCoaCloudResult {
  options: COAOption[];
  confidence: number;
  latency_ms: number;
}

/** Pitfall 4's hard gate + R-002's confidence gate, both enforced before any
 * caller sees an option — no gRPC, no I/O, fully synchronous and testable. */
export function parseCloudResponse(response: { coaJson: string; confidence: number }): COAOption[] {
  if (response.confidence < CONFIDENCE_THRESHOLD) {
    throw new LowConfidenceError(response.confidence);
  }

  const parsed: unknown = JSON.parse(response.coaJson);
  return z.array(COAOption).parse(parsed);
}

export async function generateCoaCloud(
  client: LLMServiceClient,
  params: GenerateCoaCloudParams,
): Promise<GenerateCoaCloudResult> {
  const response = await new Promise<{ coaJson: string; confidence: number; latencyMs: number }>((resolve, reject) => {
    client.generateCoa(
      { situationJson: params.situation_json, doctrineContext: params.doctrine_context, numOptions: params.num_options },
      (err, res) => (err ? reject(err) : resolve(res)),
    );
  });

  const options = parseCloudResponse(response);
  return { options, confidence: response.confidence, latency_ms: response.latencyMs };
}
