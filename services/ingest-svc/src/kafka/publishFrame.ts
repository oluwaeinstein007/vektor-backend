// Publishes one extracted frame to Kafka: header metadata is a validated
// VideoFrameMetadata (§9.7, REQ-1.1), the raw JPEG bytes are the message
// value untouched — see vektor-proto/src/schemas/video-frame.ts for why
// this isn't a single JSON envelope.
import { randomUUID } from "node:crypto";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { VideoFrameMetadata } from "@vektor/shared";
import type { ExtractedFrame } from "../rtsp/frameExtractor.js";
import { parseJpegDimensions } from "../jpeg/dimensions.js";

export interface PublishFrameOptions {
  producer: Producer;
  env: VektorEnv;
  sensorId: string;
}

export class UnparsableFrameError extends Error {}

export async function publishFrame(frame: ExtractedFrame, options: PublishFrameOptions): Promise<void> {
  const dimensions = parseJpegDimensions(frame.buffer);
  if (!dimensions) {
    throw new UnparsableFrameError(
      `frame ${frame.frameNumber} from sensor "${options.sensorId}" has no SOF0 marker — dropped, not published`,
    );
  }

  const metadata: VideoFrameMetadata = {
    event_id: randomUUID(),
    sensor_id: options.sensorId,
    frame_id: `${options.sensorId}-${frame.frameNumber}`,
    frame_number: frame.frameNumber,
    width: dimensions.width,
    height: dimensions.height,
    codec: "mjpeg",
    sensor_ts: frame.capturedAt.toISOString(),
    kafka_ts: new Date().toISOString(),
  };

  // Fail loudly before anything touches the network: a malformed envelope
  // or an out-of-sync clock (Pitfall 1) must never reach the topic.
  assertValidSensorTs(metadata.sensor_ts, metadata.sensor_id, frame.capturedAt);
  VideoFrameMetadata.parse(metadata);

  await options.producer.send({
    topic: topicName(options.env, "video", "frame"),
    messages: [
      {
        key: options.sensorId,
        value: frame.buffer,
        headers: Object.fromEntries(Object.entries(metadata).map(([field, value]) => [field, String(value)])),
      },
    ],
  });
}
