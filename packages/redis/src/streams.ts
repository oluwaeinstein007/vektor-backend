import type { Redis } from "ioredis";

// SVC-007's per-domain landing streams. Every producer (fusion-svc's Kafka
// consumers, and the temporary test emitters that stand in for feeds with
// no real producer yet) writes here through publishToStream — never a raw
// XADD — so the field layout (sensor_ts, payload) stays in one place.
export function streamKey(domain: string): string {
  return `fusion:stream:${domain}`;
}

export async function publishToStream(redis: Redis, domain: string, sensorTs: string, payload: unknown): Promise<void> {
  await redis.xadd(streamKey(domain), "*", "sensor_ts", sensorTs, "payload", JSON.stringify(payload));
}
