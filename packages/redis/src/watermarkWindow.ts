import type { Redis } from "ioredis";
import { streamKey } from "./streams.js";

/**
 * SVC-007's windowing engine — VEKTOR-PRD.md §17 PITFALL 1: sensors from
 * different domains (CV tracks, AIS, ADS-B, EW/RF) arrive at fusion-svc out
 * of `sensor_ts` order because of variable network/processing latency
 * *between domains*, even though each domain's own Kafka topic is internally
 * ordered. Ordering by Redis/Kafka arrival time instead of sensor_ts lets a
 * moving entity's late-arriving update get processed before an
 * already-processed later one, producing a phantom duplicate track.
 *
 * This buffers raw events read off each domain's Redis Stream and only
 * releases (in ascending sensor_ts order) the ones whose sensor_ts is at or
 * behind the watermark: `max(sensor_ts seen so far) - watermarkMs`. An event
 * newer than the watermark might still be beaten by a later-arriving,
 * earlier-sensor_ts event from another domain, so it stays buffered.
 */
const DEFAULT_WATERMARK_MS = 500;

export interface WindowedEvent {
  domain: string;
  sensor_ts: string; // ISO 8601
  payload: unknown;
}

export class WatermarkWindow {
  private readonly redis: Redis;
  private readonly domains: string[];
  private readonly watermarkMs: number;
  private readonly lastIds: Map<string, string>;
  private buffer: WindowedEvent[] = [];
  private maxSensorTsMs = -Infinity;

  constructor(redis: Redis, domains: string[], watermarkMs = DEFAULT_WATERMARK_MS) {
    this.redis = redis;
    this.domains = domains;
    this.watermarkMs = watermarkMs;
    this.lastIds = new Map(domains.map((d) => [d, "0"]));
  }

  /**
   * Reads any new entries across every domain stream (blocking up to
   * `blockMs` if none are immediately available — pass 0 to poll without
   * blocking), then returns every buffered event that is now safe to
   * release in strict sensor_ts order.
   *
   * A blocking read that times out with genuinely nothing new is treated as
   * "no domain has anything else in flight right now" and flushes the
   * entire remaining buffer regardless of watermark — otherwise an event
   * behind a domain that simply stops producing (feed drops, fixture data
   * ends) would wait on a watermark that can now never advance.
   */
  async poll(blockMs = 0): Promise<WindowedEvent[]> {
    const streams = this.domains.map((d) => streamKey(d));
    const ids = this.domains.map((d) => this.lastIds.get(d) ?? "0");

    const result =
      blockMs > 0
        ? await this.redis.xread("BLOCK", blockMs, "STREAMS", ...streams, ...ids)
        : await this.redis.xread("STREAMS", ...streams, ...ids);

    if (result === null) {
      if (blockMs > 0) return this.flushAll();
      return [];
    }

    for (const [streamName, entries] of result) {
      const domain = streamName.slice(streamKey("").length);
      for (const [id, fields] of entries) {
        this.lastIds.set(domain, id);
        const sensorTsIdx = fields.indexOf("sensor_ts");
        const payloadIdx = fields.indexOf("payload");
        const sensorTs = fields[sensorTsIdx + 1];
        const payloadRaw = fields[payloadIdx + 1];
        if (sensorTsIdx === -1 || payloadIdx === -1 || sensorTs === undefined || payloadRaw === undefined) continue;

        const sensorTsMs = Date.parse(sensorTs);
        if (sensorTsMs > this.maxSensorTsMs) this.maxSensorTsMs = sensorTsMs;
        this.buffer.push({ domain, sensor_ts: sensorTs, payload: JSON.parse(payloadRaw) as unknown });
      }
    }

    if (this.maxSensorTsMs === -Infinity) return [];

    const watermarkMs = this.maxSensorTsMs - this.watermarkMs;
    const ready: WindowedEvent[] = [];
    const stillBuffered: WindowedEvent[] = [];
    for (const event of this.buffer) {
      if (Date.parse(event.sensor_ts) <= watermarkMs) ready.push(event);
      else stillBuffered.push(event);
    }
    this.buffer = stillBuffered;
    ready.sort((a, b) => Date.parse(a.sensor_ts) - Date.parse(b.sensor_ts));
    return ready;
  }

  private flushAll(): WindowedEvent[] {
    const ready = [...this.buffer].sort((a, b) => Date.parse(a.sensor_ts) - Date.parse(b.sensor_ts));
    this.buffer = [];
    return ready;
  }
}
