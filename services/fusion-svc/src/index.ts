import pino from "pino";
import { createKafkaClient, type VektorEnv } from "@vektor/kafka";
import { createRedisClient, WatermarkWindow } from "@vektor/redis";
import { createDb } from "@vektor/db";
import { buildApp } from "./app.js";
import { FusionGateway } from "./socket/gateway.js";
import { runIngestConsumers, FUSION_DOMAINS } from "./kafka/ingestConsumers.js";
import { runVideoFrameConsumer } from "./kafka/videoFrameConsumer.js";
import { runPipelineOnce, createTrackManager } from "./pipeline/pipeline.js";
import { createGeofenceCheckQueue } from "./queue/geofenceProducer.js";

const logger = pino({ name: "fusion-svc" });

const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:9092";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const VEKTOR_ENV = (process.env.VEKTOR_ENV ?? "dev") as VektorEnv;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 3007);
const WATERMARK_MS = Number(process.env.WATERMARK_MS ?? 500); // Pitfall 1 (§17)
const POLL_BLOCK_MS = Number(process.env.POLL_BLOCK_MS ?? 1000);
const VIDEO_FRAME_MIN_INTERVAL_MS = Number(process.env.VIDEO_FRAME_MIN_INTERVAL_MS ?? 750);

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);
  const redis = createRedisClient(REDIS_URL);
  const kafka = createKafkaClient({ clientId: "fusion-svc", brokers: KAFKA_BROKERS.split(",") });
  const consumer = kafka.consumer({ groupId: "fusion-svc" });
  await consumer.connect();

  // Own Consumer instance: a single kafkajs Consumer can only run one
  // eachMessage handler, and this topic's raw-bytes messages need a
  // different decode path than the JSON domains ingestConsumers.ts handles
  // (see videoFrameConsumer.ts's header comment).
  const videoFrameConsumer = kafka.consumer({ groupId: "fusion-svc-video-frame" });
  await videoFrameConsumer.connect();

  const app = buildApp({ db });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "fusion-svc HTTP (health + blue-force/no-strike REST) listening");

  // Attached to the same HTTP server Fastify is already listening on — this
  // is the Socket.io gateway apps/web's FE-002 has been waiting on since
  // Phase 1 (see socket/gateway.ts's header comment).
  const gateway = new FusionGateway(app.server);

  const ingestPromise = runIngestConsumers({
    consumer,
    redis,
    env: VEKTOR_ENV,
    onSensorHealth: (health) => gateway.emitSensorStatus(health),
    onError: (domain, err) => logger.warn({ domain, err }, "failed to ingest event"),
  });

  const videoFramePromise = runVideoFrameConsumer({
    consumer: videoFrameConsumer,
    env: VEKTOR_ENV,
    minIntervalMs: VIDEO_FRAME_MIN_INTERVAL_MS,
    onFrame: (frame) =>
      gateway.emitVideoFrame({
        sensor_id: frame.sensorId,
        jpeg_base64: frame.jpegBase64,
        frame_number: frame.frameNumber,
        width: frame.width,
        height: frame.height,
        captured_at: frame.capturedAt,
      }),
    onError: (err) => logger.warn({ err }, "failed to relay video frame"),
  });

  const window = new WatermarkWindow(redis, [...FUSION_DOMAINS], WATERMARK_MS);
  const trackManager = createTrackManager();
  const geofenceQueue = createGeofenceCheckQueue(REDIS_URL);
  const entityTopicProducer = kafka.producer();
  await entityTopicProducer.connect();

  let running = true;
  let processedCount = 0;
  const pipelineLoop = (async () => {
    while (running) {
      try {
        const processed = await runPipelineOnce(
          { window, trackManager, db, gateway, geofenceQueue, entityTopicProducer, env: VEKTOR_ENV },
          POLL_BLOCK_MS,
        );
        processedCount += processed.length;
      } catch (err) {
        logger.warn({ err }, "pipeline cycle failed");
      }
    }
  })();

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal, processedCount, activeTracks: trackManager.size }, "shutting down");
    running = false;
    await pipelineLoop;
    await app.close();
    await gateway.close();
    await consumer.disconnect();
    await videoFrameConsumer.disconnect();
    await geofenceQueue.close();
    await entityTopicProducer.disconnect();
    redis.disconnect();
    await db.$client.end();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await Promise.all([ingestPromise, videoFramePromise]);
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start fusion-svc");
  process.exit(1);
});
