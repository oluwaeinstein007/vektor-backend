import pino from "pino";
import { createKafkaClient, type VektorEnv } from "@vektor/kafka";
import { runIngest } from "./app.js";

const logger = pino({ name: "ingest-svc" });

const SOURCE_URL = process.env.INGEST_SOURCE_URL;
const SENSOR_ID = process.env.SENSOR_ID;
const KAFKA_BROKERS = process.env.KAFKA_BROKERS;
const VEKTOR_ENV = (process.env.VEKTOR_ENV ?? "dev") as VektorEnv;
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT as "tcp" | "udp" | undefined;

if (!SOURCE_URL) {
  throw new Error("INGEST_SOURCE_URL is required");
}
if (!SENSOR_ID) {
  throw new Error("SENSOR_ID is required");
}

const kafka = createKafkaClient({
  clientId: `ingest-svc-${SENSOR_ID}`,
  brokers: (KAFKA_BROKERS ?? "localhost:9092").split(","),
});
const producer = kafka.producer();

let framesPublished = 0;

producer
  .connect()
  .then(() => {
    logger.info({ sensorId: SENSOR_ID, sourceUrl: SOURCE_URL }, "connected to Kafka, starting frame extraction");

    const handle = runIngest({
      sourceUrl: SOURCE_URL,
      rtspTransport: RTSP_TRANSPORT,
      producer,
      env: VEKTOR_ENV,
      sensorId: SENSOR_ID,
      onPublished: () => {
        framesPublished += 1;
      },
      onFrameError: (err) => logger.warn({ err }, "frame publish failed"),
    });

    async function shutdown(signal: string) {
      logger.info({ signal, framesPublished }, "shutting down");
      handle.stop();
      await producer.disconnect();
      process.exit(0);
    }

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  })
  .catch((err: unknown) => {
    logger.error({ err }, "failed to start ingest-svc");
    process.exit(1);
  });
