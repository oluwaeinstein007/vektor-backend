// CLI entrypoint: connects a MAVLink UDP source (SITL, a real
// flight-controller/companion-computer link) to MQTT so ingest-svc's
// mqttAdapter (already running against the shared broker) picks it up and
// SVC-003's pipeline republishes it onto Kafka as an IotTelemetryEvent —
// fusion-svc's fromIot() then turns a recognized MAVLink payload into a
// tracked FRIENDLY entity.
import pino from "pino";
import { startMavlinkSource } from "./mavlinkSource.js";
import { startBridge } from "./bridge.js";

const logger = pino({ name: "mavlink-bridge" });

async function main(): Promise<void> {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    throw new Error("MQTT_BROKER_URL is required (e.g. mqtt://localhost:11883)");
  }
  const topicPrefix = process.env.MQTT_TOPIC_PREFIX ?? "vektor/sensors/mavlink";
  const receivePort = process.env.MAVLINK_RECEIVE_PORT ? Number(process.env.MAVLINK_RECEIVE_PORT) : undefined;
  const sendPort = process.env.MAVLINK_SEND_PORT ? Number(process.env.MAVLINK_SEND_PORT) : undefined;
  const ip = process.env.MAVLINK_IP;

  const bridge = startBridge({
    brokerUrl,
    topicPrefix,
    onPublish: (topic) => logger.debug({ topic }, "published telemetry"),
    onError: (err) => logger.warn({ err }, "mqtt publish error"),
  });

  const source = await startMavlinkSource({
    receivePort,
    sendPort,
    ip,
    onTick: (tick) => bridge.publish(tick),
    onError: (err) => logger.warn({ err }, "mavlink source error"),
  });

  logger.info(
    { receivePort: receivePort ?? 14550, sendPort: sendPort ?? 14555, ip, brokerUrl, topicPrefix },
    "mavlink-bridge started",
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await source.stop();
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start mavlink-bridge");
  process.exit(1);
});
