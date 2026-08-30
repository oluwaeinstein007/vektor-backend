// ingest-svc's CLI entrypoint runs whichever adapters have their env vars
// set — one process can run any combination of RTSP/SRT (SVC-001), AIS,
// ADS-B, MQTT IoT (SVC-003), and a GeoTIFF inbox watcher (SVC-002), all
// sharing one Kafka producer connection. A deployment that only needs one
// adapter just sets that adapter's env vars and leaves the rest unset.
import pino from "pino";
import { createKafkaClient, type VektorEnv } from "@vektor/kafka";
import { runIngest } from "./app.js";
import { startAisAdapter } from "./ais/aisAdapter.js";
import { startAdsbAdapter } from "./adsb/adsbAdapter.js";
import { startMqttAdapter } from "./mqtt/mqttAdapter.js";
import { watchGeoTiffInbox } from "./geotiff/watchInbox.js";
import { buildFieldIngestApp } from "./http/app.js";

const logger = pino({ name: "ingest-svc" });

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:9092";
const VEKTOR_ENV = (process.env.VEKTOR_ENV ?? "dev") as VektorEnv;

const kafka = createKafkaClient({ clientId: "ingest-svc", brokers: KAFKA_BROKERS.split(",") });
const producer = kafka.producer();
const stopFns: Array<() => void | Promise<void>> = [];

function startRtspAdapter(): boolean {
  const sourceUrl = process.env.INGEST_SOURCE_URL;
  const sensorId = process.env.RTSP_SENSOR_ID ?? process.env.SENSOR_ID;
  if (!sourceUrl || !sensorId) return false;

  let framesPublished = 0;
  const handle = runIngest({
    sourceUrl,
    rtspTransport: process.env.RTSP_TRANSPORT as "tcp" | "udp" | undefined,
    producer,
    env: VEKTOR_ENV,
    sensorId,
    onPublished: () => {
      framesPublished += 1;
    },
    onFrameError: (err) => logger.warn({ err, adapter: "rtsp" }, "frame publish failed"),
  });
  stopFns.push(() => {
    logger.info({ framesPublished }, "stopping rtsp adapter");
    handle.stop();
  });
  logger.info({ sourceUrl, sensorId }, "rtsp adapter started");
  return true;
}

function startAisFeed(): boolean {
  const host = process.env.AIS_HOST;
  const port = process.env.AIS_PORT;
  const sensorId = process.env.AIS_SENSOR_ID;
  if (!host || !port || !sensorId) return false;

  const handle = startAisAdapter({
    host,
    port: Number(port),
    producer,
    env: VEKTOR_ENV,
    sensorId,
    onError: (err) => logger.warn({ err, adapter: "ais" }, "ais adapter error"),
  });
  stopFns.push(() => handle.stop());
  logger.info({ host, port, sensorId }, "ais adapter started");
  return true;
}

function startAdsbFeed(): boolean {
  const host = process.env.ADSB_HOST;
  const port = process.env.ADSB_PORT;
  const sensorId = process.env.ADSB_SENSOR_ID;
  if (!host || !port || !sensorId) return false;

  const handle = startAdsbAdapter({
    host,
    port: Number(port),
    producer,
    env: VEKTOR_ENV,
    sensorId,
    onError: (err) => logger.warn({ err, adapter: "adsb" }, "adsb adapter error"),
  });
  stopFns.push(() => handle.stop());
  logger.info({ host, port, sensorId }, "adsb adapter started");
  return true;
}

function startMqttFeed(): boolean {
  const brokerUrl = process.env.MQTT_BROKER_URL;
  const topicFilter = process.env.MQTT_TOPIC_FILTER;
  const sensorId = process.env.MQTT_SENSOR_ID;
  if (!brokerUrl || !topicFilter || !sensorId) return false;

  const handle = startMqttAdapter({
    brokerUrl,
    topicFilter,
    producer,
    env: VEKTOR_ENV,
    sensorId,
    onError: (err) => logger.warn({ err, adapter: "mqtt" }, "mqtt adapter error"),
  });
  stopFns.push(() => handle.stop());
  logger.info({ brokerUrl, topicFilter, sensorId }, "mqtt adapter started");
  return true;
}

function startGeoTiffWatcher(): boolean {
  const inboxDir = process.env.GEOTIFF_INBOX_DIR;
  const sensorId = process.env.GEOTIFF_SENSOR_ID;
  if (!inboxDir || !sensorId) return false;

  const handle = watchGeoTiffInbox(
    inboxDir,
    { producer, env: VEKTOR_ENV, sensorId },
    (event) => logger.info({ fileName: event.file_name, bbox: event.bbox }, "geotiff file ingested"),
    (err) => logger.warn({ err, adapter: "geotiff" }, "geotiff ingest error"),
  );
  stopFns.push(() => handle.stop());
  logger.info({ inboxDir, sensorId }, "geotiff inbox watcher started");
  return true;
}

async function startFieldIngestHttp(): Promise<boolean> {
  const secret = process.env.FIELD_DEVICE_SHARED_SECRET;
  if (!secret) return false;

  const port = Number(process.env.FIELD_INGEST_PORT ?? 3011);
  const app = buildFieldIngestApp({ producer, env: VEKTOR_ENV, deviceSharedSecret: secret });
  await app.listen({ port, host: "0.0.0.0" });
  stopFns.push(() => app.close());
  logger.info({ port }, "field ingest HTTP server started");
  return true;
}

async function main(): Promise<void> {
  await producer.connect();
  logger.info("connected to Kafka");

  const started = [
    startRtspAdapter(),
    startAisFeed(),
    startAdsbFeed(),
    startMqttFeed(),
    startGeoTiffWatcher(),
    await startFieldIngestHttp(),
  ];

  if (!started.some(Boolean)) {
    throw new Error(
      "no adapter configured — set env vars for at least one of: " +
        "RTSP (INGEST_SOURCE_URL + RTSP_SENSOR_ID or SENSOR_ID), " +
        "AIS (AIS_HOST + AIS_PORT + AIS_SENSOR_ID), " +
        "ADS-B (ADSB_HOST + ADSB_PORT + ADSB_SENSOR_ID), " +
        "MQTT (MQTT_BROKER_URL + MQTT_TOPIC_FILTER + MQTT_SENSOR_ID), " +
        "GeoTIFF (GEOTIFF_INBOX_DIR + GEOTIFF_SENSOR_ID), " +
        "Field ingest HTTP (FIELD_DEVICE_SHARED_SECRET, optionally FIELD_INGEST_PORT)",
    );
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await Promise.all(stopFns.map((stop) => stop()));
  await producer.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start ingest-svc");
  process.exit(1);
});
