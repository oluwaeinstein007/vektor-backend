// SVC-004's "sensor_ts validation middleware" — VEKTOR-PRD.md §17 Pitfall 1.
// Every producer in every ingest source (SVC-001/002/003) must call this
// before publishing, so a sensor with a broken or unsynced clock is caught
// at the ingestion boundary instead of silently corrupting fusion-svc's
// event-time ordering downstream. The NTP/PTP sync daemon itself (the other
// half of SVC-004) is infra config (chrony/ptp4l), not application code —
// this is the part of SVC-004 that lives in this repo.
export class SensorTimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SensorTimestampError";
  }
}

// REQ-1.4 targets < 5ms skew after NTP/PTP sync; this ceiling is deliberately
// much looser (a coarse ingest-boundary sanity check, not the precision
// target itself) so a sensor that's merely a few seconds off — clock drift,
// not a broken clock — doesn't get its whole feed rejected. fusion-svc's
// 500ms event-time watermark (Pitfall 1) is the layer that actually enforces
// ordering precision.
export const MAX_SENSOR_CLOCK_SKEW_MS = 5000;

export function assertValidSensorTs(sensorTs: string, sensorId: string, now: Date = new Date()): void {
  const parsed = Date.parse(sensorTs);
  if (Number.isNaN(parsed)) {
    throw new SensorTimestampError(
      `sensor_ts "${sensorTs}" from sensor "${sensorId}" is not a valid ISO 8601 timestamp`,
    );
  }

  const skewMs = Math.abs(now.getTime() - parsed);
  if (skewMs > MAX_SENSOR_CLOCK_SKEW_MS) {
    throw new SensorTimestampError(
      `sensor_ts from sensor "${sensorId}" is ${skewMs}ms out of sync with the local clock ` +
        `(max ${MAX_SENSOR_CLOCK_SKEW_MS}ms) — check the sensor's NTP/PTP sync (REQ-1.4)`,
    );
  }
}
