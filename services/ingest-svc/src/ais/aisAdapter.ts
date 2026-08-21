// SVC-003 (REQ-1.5): connects to a line-delimited NMEA/AIVDM TCP feed — the
// common transport for AIS receivers and aggregators — decodes each Class A
// position report, and publishes it to Kafka.
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { AisPositionReport } from "@vektor/shared";
import { decodeAivdmPositionReport } from "./aivdmDecoder.js";

export interface AisAdapterOptions {
  host: string;
  port: number;
  producer: Producer;
  env: VektorEnv;
  sensorId: string;
  onPublished?: (event: AisPositionReport) => void;
  onError?: (err: Error) => void;
}

export interface AisAdapterHandle {
  socket: Socket;
  stop: () => void;
}

export function startAisAdapter(options: AisAdapterOptions): AisAdapterHandle {
  const socket = createConnection({ host: options.host, port: options.port });
  let buffer = "";

  socket.on("error", (err) => options.onError?.(err));

  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      void handleSentence(line, options);
    }
  });

  return { socket, stop: () => socket.destroy() };
}

async function handleSentence(sentence: string, options: AisAdapterOptions): Promise<void> {
  try {
    const decoded = decodeAivdmPositionReport(sentence);
    // Not every line on the feed is a decodable Class A position report
    // (other message types, malformed fragments) — silently skip those
    // rather than treating them as errors.
    if (!decoded) return;

    const now = new Date();
    const event: AisPositionReport = {
      event_id: randomUUID(),
      sensor_id: options.sensorId,
      mmsi: decoded.mmsi,
      message_type: decoded.messageType,
      nav_status: decoded.navStatus,
      lat: decoded.lat,
      lon: decoded.lon,
      speed_knots: decoded.speedKnots,
      course_deg: decoded.courseDeg,
      heading_deg: decoded.headingDeg,
      sensor_ts: now.toISOString(),
      kafka_ts: new Date().toISOString(),
    };

    assertValidSensorTs(event.sensor_ts, event.sensor_id, now);
    AisPositionReport.parse(event);

    await options.producer.send({
      topic: topicName(options.env, "ais", "position"),
      messages: [{ key: options.sensorId, value: JSON.stringify(event) }],
    });

    options.onPublished?.(event);
  } catch (err) {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
