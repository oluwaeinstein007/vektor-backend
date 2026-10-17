/**
 * NW-020 — TrackState to a real sensor event.
 *
 * Every shape here comes from `@vektor/shared` and is run through its Zod
 * parser before publishing. That is not belt-and-braces: a scenario player
 * that emits almost-valid events would make fusion-svc's own validation
 * failures look like scenario bugs, and the entire value of this package is
 * that it exercises the real contracts.
 */
import { randomUUID } from "node:crypto";
import {
  AdsbPositionReport,
  AisPositionReport,
  IotTelemetryEvent,
  type MavlinkTelemetryPayload,
} from "@vektor/shared";
import { MPS_TO_KMH, MPS_TO_KNOTS } from "./geo.js";
import type { TrackState } from "./engine.js";
import type { ScenarioEntity } from "./scenario.js";

export interface EmitOptions {
  sensorId: string;
  /** Wall-clock instant this event represents. */
  sensorTs: Date;
  /**
   * Deterministic id generator. Live playback uses randomUUID; dry-run
   * substitutes a counter so a golden file is stable. event_id is the only
   * genuinely non-deterministic field in an otherwise pure pipeline, so it
   * is injected rather than called directly.
   */
  nextEventId?: () => string;
}

export interface EmittedEvent {
  /** Topic suffix: the `domain.action` half of `{env}.vektor.{domain}.{action}`. */
  domain: string;
  action: string;
  key: string;
  value: unknown;
}

export function toEvent(entity: ScenarioEntity, state: TrackState, opts: EmitOptions): EmittedEvent {
  const eventId = (opts.nextEventId ?? randomUUID)();
  const ts = opts.sensorTs.toISOString();

  switch (entity.kind) {
    case "ais": {
      const value = AisPositionReport.parse({
        event_id: eventId,
        sensor_id: opts.sensorId,
        mmsi: entity.mmsi!,
        message_type: 1,
        nav_status: state.speed_mps < 0.1 ? 5 : 0, // 5 = moored, 0 = under way
        lat: state.lat,
        lon: state.lon,
        speed_knots: round(state.speed_mps * MPS_TO_KNOTS, 2),
        course_deg: round(state.heading_deg, 1),
        // AIS true heading is an integer 0-359; 360 is out of range where
        // course_deg allows it. Rounding 359.7 up would fail validation.
        heading_deg: Math.min(359, Math.round(state.heading_deg)),
        sensor_ts: ts,
        kafka_ts: ts,
      });
      return { domain: "ais", action: "position", key: entity.mmsi!, value };
    }

    case "adsb": {
      const value = AdsbPositionReport.parse({
        event_id: eventId,
        sensor_id: opts.sensorId,
        icao24: entity.icao24!,
        callsign: entity.callsign ?? null,
        altitude_ft: round(state.alt_m * 3.280839895, 0),
        ground_speed_kts: round(state.speed_mps * MPS_TO_KNOTS, 1),
        track_deg: round(state.heading_deg, 1),
        lat: state.lat,
        lon: state.lon,
        vertical_rate_fpm: 0,
        squawk: null,
        on_ground: state.alt_m < 1,
        sensor_ts: ts,
        kafka_ts: ts,
      });
      return { domain: "adsb", action: "position", key: entity.icao24!, value };
    }

    case "iot": {
      // Shaped as MavlinkTelemetryPayload specifically: fusion-svc's iot
      // mapper discriminates on payload.device_class and silently SKIPS
      // anything it doesn't recognise, so a generic payload would publish
      // happily and fuse into nothing at all.
      const payload: MavlinkTelemetryPayload = {
        device_class: "mavlink",
        system_id: 1,
        lat: state.lat,
        lon: state.lon,
        alt_m: round(state.alt_m, 1),
        heading_deg: round(state.heading_deg, 1),
        groundspeed_mps: round(state.speed_mps, 2),
      };
      const deviceId = entity.device_id ?? entity.id;
      const value = IotTelemetryEvent.parse({
        event_id: eventId,
        sensor_id: opts.sensorId,
        mqtt_topic: `vektor/sensors/${deviceId}`,
        payload,
        sensor_ts: ts,
        kafka_ts: ts,
      });
      return { domain: "iot", action: "telemetry", key: deviceId, value };
    }
  }
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
