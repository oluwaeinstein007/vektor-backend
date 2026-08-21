// packages/kafka/src/schemas/detection.ts — VEKTOR-PRD.md §12.3.
// DetectionEvent and SensorHealth are defined once in vektor-proto; this
// package only re-exports them for kafka-consumer call sites.
export { DetectionEvent, SensorHealth } from "@vektor/proto";
