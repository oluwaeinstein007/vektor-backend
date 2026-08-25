// ML-011 — edge COA generation via node-llama-cpp, for a disconnected/
// degraded deployment with no reachable vektor-ml-enclave. Production
// target per §10.3 is Mistral 7B Q4_K_M; the model path is a runtime
// parameter, not hardcoded, so swapping models is a config change.
//
// Grammar-constrained generation (llama.createGrammarForJsonSchema) rather
// than free-text + regex extraction: node-llama-cpp can force every
// generated token to stay within a GBNF grammar derived directly from the
// COAOption shape, which is both more reliable on a small/quantized model
// and makes llm-cloud-svc's markdown-fence/preamble-stripping problem
// (server.py's _extract_json) moot on this path — the output is
// syntactically guaranteed to already be a JSON array matching the schema.
//
// Pitfall 6 (node-llama-cpp memory leak on long-running sessions): every
// model/context is disposed in a `finally`, and a fresh model+context is
// loaded per call rather than kept as a long-lived singleton — this
// service's edge path is invoked rarely enough (COA generation, not a
// per-frame hot path) that the reload cost is worth it for the leak safety.
import { getLlama, LlamaChatSession } from "node-llama-cpp";
import { z } from "zod";
import { COAOption } from "@vektor/shared";

const MIN_CONFIDENCE = Number(process.env.COA_MIN_CONFIDENCE ?? 0.15);

// Not typed as `GbnfJsonSchema` up front — createGrammarForJsonSchema's
// generic signature needs to infer the literal `type: "array"`/"object"/etc.
// string-literal types directly from an object literal passed at the call
// site; widening through an explicitly-typed intermediate const defeats
// that inference (TS2345). Built inline via this function instead (still
// `as const` at the return site, so the literal types survive).
//
// `minItems`/`maxItems` are both pinned to `numOptions`, and every string
// field/inner array carries a length cap — without these, the grammar
// allows an array of *any* length and strings of *any* length, and a
// small/quantized model has no grammar-level pressure to ever emit the
// closing quote/bracket: it can (and, observed against the real
// Qwen2.5-0.5B test fixture, did) loop on a token pattern indefinitely
// inside a single string field, blowing through the token budget before
// the JSON closes and producing a truncated "Unterminated string in JSON"
// parse failure. Bounding every field's length makes termination
// structurally guaranteed rather than dependent on the model choosing to
// stop. Found 2026-08-24.
function buildCoaOptionsGbnfSchema(numOptions: number) {
  return {
    type: "array",
    minItems: numOptions,
    maxItems: numOptions,
    items: {
      type: "object",
      properties: {
        rank: { type: "integer" },
        title: { type: "string", maxLength: 100 },
        rationale: { type: "string", maxLength: 400 },
        confidence: { type: "number" },
        required_assets: { type: "array", maxItems: 6, items: { type: "string", maxLength: 60 } },
        estimated_duration_min: { type: "number" },
        context_factors: { type: "array", maxItems: 6, items: { type: "string", maxLength: 120 } },
      },
    },
  } as const;
}

export interface GenerateCoaEdgeParams {
  modelPath: string;
  situationJson: string;
  doctrineContext: string;
  numOptions: number;
}

export interface GenerateCoaEdgeResult {
  options: COAOption[];
}

function buildPrompt(situationJson: string, doctrineContext: string, numOptions: number): string {
  // Same structure/rationale as llm-cloud-svc's _build_prompt — kept
  // independent (not shared code across the TS<->Python boundary) since
  // that boundary is gRPC-only by design (Pitfall 3), not a shared module.
  return (
    "You are a tactical decision-support assistant generating Courses of Action " +
    "(COA) for a human commander, who retains sole approval authority.\n\n" +
    `SITUATION (JSON):\n${situationJson}\n\n` +
    `DOCTRINE CONTEXT (retrieved, may be empty):\n${doctrineContext}\n\n` +
    `Generate exactly ${numOptions} ranked COA options as a JSON array. Every option must ` +
    "respect any no-strike zones and never target a FRIENDLY-affiliated entity. " +
    "context_factors must list the specific situation/doctrine inputs that drove the option."
  );
}

export async function generateCoaEdge(params: GenerateCoaEdgeParams): Promise<GenerateCoaEdgeResult> {
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath: params.modelPath });
  try {
    const context = await model.createContext();
    try {
      const grammar = await llama.createGrammarForJsonSchema(buildCoaOptionsGbnfSchema(params.numOptions));
      const session = new LlamaChatSession({ contextSequence: context.getSequence() });

      // 1024 tokens was too tight even for a single option on the small
      // test fixture model once minItems/maxItems weren't yet pinning the
      // array length — 2048 gives real headroom for numOptions > 1 too.
      const raw = await session.prompt(buildPrompt(params.situationJson, params.doctrineContext, params.numOptions), {
        grammar,
        maxTokens: 2048,
        temperature: 0.2,
      });

      const parsed: unknown = JSON.parse(raw);
      // Same hard Zod gate cloudClient.ts applies — grammar-constrained
      // generation guarantees syntactic JSON matching the GBNF schema, not
      // semantic correctness (a model can still emit e.g. confidence: 5),
      // so this still has to run through the real COAOption schema.
      const options = z.array(COAOption).parse(parsed);

      const avgConfidence = options.reduce((sum, o) => sum + o.confidence, 0) / options.length;
      if (avgConfidence < MIN_CONFIDENCE) {
        throw new Error(`edge COA average confidence ${avgConfidence} is below the ${MIN_CONFIDENCE} threshold (R-002)`);
      }

      return { options };
    } finally {
      await context.dispose();
    }
  } finally {
    await model.dispose();
  }
}
