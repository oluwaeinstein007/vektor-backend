// @vektor/shared/llm — Node-only gRPC stubs (LLMServiceClient etc.), kept out
// of the main "@vektor/shared" barrel because they pull in @grpc/grpc-js,
// which requires Node built-ins (fs) unavailable in a browser bundle.
// Only Node-side services (coa-svc) should import from here.
export * from "@vektor/proto/llm";
