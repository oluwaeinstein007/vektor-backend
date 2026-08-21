// SVC-003 (REQ-1.5): connects to an SBS-1 TCP feed (dump1090-class ADS-B
// receiver, default port 30003) and publishes each parsed message to Kafka.
// Each line is a partial state update for one aircraft (a position-only
// line, a velocity-only line, an identification-only line, ...) — merging
// those into one coherent per-aircraft state is fusion-svc's job (Phase 3),
// not this adapter's.
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { AdsbPositionReport } from "@vektor/shared";
import { parseSbs1Line } from "./sbs1Parser.js";

export interface AdsbAdapterOptions {
  host: string;
  port: number;
  producer: Producer;
  env: VektorEnv;
  sensorId: string;
  onPublished?: (event: AdsbPositionReport) => void;
  onError?: (err: Error) => void;
}

export interface AdsbAdapterHandle {
  socket: Socket;
  stop: () => void;
}

export function startAdsbAdapter(options: AdsbAdapterOptions): AdsbAdapterHandle {
  const socket = createConnection({ host: options.host, port: options.port });
  let buffer = "";

  socket.on("error", (err) => options.onError?.(err));

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      void handleLine(line, options);
    }
  });

  return { socket, stop: () => socket.destroy() };
}

async function handleLine(line: string, options: AdsbAdapterOptions): Promise<void> {
  try {
    const decoded = parseSbs1Line(line);
    if (!decoded) return; // not an MSG line (SBS-1 also emits SEL/ID/AIR/STA lines) — skip

    const now = new Date();
    const event: AdsbPositionReport = {
      event_id: randomUUID(),
      sensor_id: options.sensorId,
      icao24: decoded.icao24,
      callsign: decoded.callsign,
      altitude_ft: decoded.altitudeFt,
      ground_speed_kts: decoded.groundSpeedKts,
      track_deg: decoded.trackDeg,
      lat: decoded.lat,
      lon: decoded.lon,
      vertical_rate_fpm: decoded.verticalRateFpm,
      squawk: decoded.squawk,
      on_ground: decoded.onGround,
      sensor_ts: now.toISOString(),
      kafka_ts: new Date().toISOString(),
    };

    assertValidSensorTs(event.sensor_ts, event.sensor_id, now);
    AdsbPositionReport.parse(event);

    await options.producer.send({
      topic: topicName(options.env, "adsb", "position"),
      messages: [{ key: options.sensorId, value: JSON.stringify(event) }],
    });

    options.onPublished?.(event);
  } catch (err) {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
