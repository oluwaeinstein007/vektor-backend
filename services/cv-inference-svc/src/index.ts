import pino from "pino";
import { createKafkaClient, type VektorEnv } from "@vektor/kafka";
import { authOptionsFromEnv } from "@vektor/auth";
import { DetectionModel } from "./inference/session.js";
import { runFrameConsumer } from "./kafka/processFrames.js";
import { buildApp } from "./app.js";
import { COCO_CLASS_NAMES } from "./cocoClasses.js";

const logger = pino({ name: "cv-inference-svc" });

const MODEL_PATH = process.env.MODEL_PATH;
const KAFKA_BROKERS = process.env.KAFKA_BROKERS ?? "localhost:9092";
const VEKTOR_ENV = (process.env.VEKTOR_ENV ?? "dev") as VektorEnv;
const REQUIRE_GPU = process.env.REQUIRE_GPU === "true";
const PORT = Number(process.env.PORT ?? 3006);
const CLASS_NAMES = process.env.CLASS_NAMES ? process.env.CLASS_NAMES.split(",") : COCO_CLASS_NAMES;

if (!MODEL_PATH) {
  throw new Error("MODEL_PATH is required (path to a YOLOv8 ONNX model)");
}

async function main(): Promise<void> {
  const model = await DetectionModel.load(MODEL_PATH!, { requireGpu: REQUIRE_GPU });
  logger.info({ modelPath: MODEL_PATH, executionProvider: model.executionProvider }, "model loaded");

  const app = buildApp({ model, requireGpu: REQUIRE_GPU, auth: authOptionsFromEnv() });
  await app.listen({ port: PORT, host: "0.0.0.0" });
  logger.info({ port: PORT }, "cv-inference-svc HTTP (health + hot-swap) listening");

  const kafka = createKafkaClient({ clientId: "cv-inference-svc", brokers: KAFKA_BROKERS.split(",") });
// Consumer group ids are namespaced by VEKTOR_ENV. Without this,
// VEKTOR_ENV isolates the TOPICS but not the GROUP, so two instances on one
// broker — a `dev` stack and a `perf` stack, say — join the same group and
// Kafka splits the partitions between them. Each then silently receives a
// subset of the other's topics and none of its own. Observed, not
// theoretical: a verification run produced zero entities because a peer's
// `perf` instance held three of the five partitions. edge-sync-svc already
// namespaced its group by node id for the same class of reason.
//
// NOTE: changing a group id resets its committed offsets, so a deployment
// that upgrades past this starts from the configured auto-offset position
// once.
  const consumer = kafka.consumer({ groupId: `${VEKTOR_ENV}.cv-inference-svc` });
  const producer = kafka.producer();
  await consumer.connect();
  await producer.connect();

  let detectionsPublished = 0;
  const consumerPromise = runFrameConsumer({
    consumer,
    producer,
    model,
    classNames: CLASS_NAMES,
    env: VEKTOR_ENV,
    onDetections: (events) => {
      detectionsPublished += events.length;
    },
    onError: (err) => logger.warn({ err }, "frame processing failed"),
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal, detectionsPublished }, "shutting down");
    await app.close();
    await consumer.disconnect();
    await producer.disconnect();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await consumerPromise;
}

main().catch((err: unknown) => {
  logger.error({ err }, "failed to start cv-inference-svc");
  process.exit(1);
});
