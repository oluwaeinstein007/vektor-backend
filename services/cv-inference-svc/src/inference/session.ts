// ML-002/ML-006: wraps onnxruntime-node with (a) Pitfall 5's GPU-fail-fast
// discipline and (b) hot-swapping the active model without restart (ML-006,
// REQ-2.6).
//
// Pitfall 5: a mismatched CUDA toolkit version causes onnxruntime-node to
// silently fall back to CPU execution — 10-50x slower with no obvious
// error. The mitigation here isn't a post-hoc check of which provider got
// selected; it's stronger than that: when a GPU is required, "cpu" is
// never included as a fallback in the execution-provider list, so a CUDA
// init failure throws immediately at session-creation time instead of
// quietly downgrading. requireGpu defaults to false because this sandbox
// (and most local dev/CI) has no GPU at all — set it true for any
// deployment where GPU throughput is actually required.
import * as ort from "onnxruntime-node";

export interface LoadModelOptions {
  requireGpu?: boolean;
}

export class DetectionModel {
  private session: ort.InferenceSession;
  readonly executionProvider: "cuda" | "cpu";

  private constructor(session: ort.InferenceSession, executionProvider: "cuda" | "cpu") {
    this.session = session;
    this.executionProvider = executionProvider;
  }

  static async load(modelPath: string, options: LoadModelOptions = {}): Promise<DetectionModel> {
    const requireGpu = options.requireGpu ?? false;
    const provider: "cuda" | "cpu" = requireGpu ? "cuda" : "cpu";

    let session: ort.InferenceSession;
    try {
      session = await ort.InferenceSession.create(modelPath, { executionProviders: [provider] });
    } catch (err) {
      if (requireGpu) {
        throw new Error(
          "GPU execution provider (CUDA) is required but unavailable — refusing to silently fall back to CPU " +
            "(Pitfall 5: a CUDA/onnxruntime-node version mismatch causes 10-50x throughput loss with no obvious " +
            `error). Original error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }

    return new DetectionModel(session, provider);
  }

  /** ML-006: swaps the active session for a new model without dropping any in-flight infer() calls on the old one. */
  async swap(modelPath: string): Promise<void> {
    const newSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: [this.executionProvider],
    });
    this.session = newSession;
  }

  async infer(tensorData: Float32Array, targetSize: number): Promise<{ data: Float32Array; numClasses: number; numAnchors: number }> {
    // Captured once: an in-flight run() keeps using the session it started
    // with even if swap() reassigns this.session before the run resolves.
    const session = this.session;
    const inputName = session.inputNames[0];
    if (!inputName) throw new Error("loaded ONNX model declares no input");

    const inputTensor = new ort.Tensor("float32", tensorData, [1, 3, targetSize, targetSize]);
    const outputs = await session.run({ [inputName]: inputTensor });

    const outputName = session.outputNames[0];
    if (!outputName) throw new Error("loaded ONNX model declares no output");
    const outputTensor = outputs[outputName]!;
    const dims = outputTensor.dims;
    if (dims.length !== 3) {
      throw new Error(`expected a YOLOv8-shaped [1, 4+numClasses, numAnchors] output, got dims ${dims.join("x")}`);
    }
    const [, channels, numAnchors] = dims as [number, number, number];

    return {
      data: outputTensor.data as Float32Array,
      numClasses: channels - 4,
      numAnchors,
    };
  }
}
