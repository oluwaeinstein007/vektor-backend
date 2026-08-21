// @vektor/shared — VEKTOR-PRD.md §12.1.
// Every schema is defined once in vektor-proto; this package only re-exports
// it so every app/service imports from "@vektor/shared" without each one
// taking a direct dependency on the contract repo's package name.
export * from "@vektor/proto";
