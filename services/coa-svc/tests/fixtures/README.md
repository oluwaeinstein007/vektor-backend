# Test fixtures

`qwen2.5-0.5b-instruct-q4_k_m.gguf` — a real, small (Q4_K_M quantized, ~470MB)
instruction-tuned GGUF model from
[Qwen/Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF),
used by `tests/edgeClient.test.ts` to verify ML-011's edge COA path
(node-llama-cpp) against real model inference rather than a mock.

The production target per VEKTOR-PRD.md §10.3 is Mistral 7B Q4_K_M — this
fixture is deliberately much smaller (0.5B vs 7B) so it downloads and runs
in seconds on CPU instead of minutes, matching the same "small real fixture
instead of the full production model" exception cv-inference-svc's ONNX
fixtures already established (see that package's `tests/fixtures/README.md`).
`generateCoaEdge()`'s model path is a runtime parameter either way, so
swapping in a real Mistral 7B Q4_K_M GGUF for production is a config change,
not a code change.

This is a real binary checked in for the same reason as the ONNX
fixtures — `.gguf` should get the same `.gitattributes binary` treatment
before committing (see `*.onnx binary` precedent in vektor-platform's
`.gitattributes`).
