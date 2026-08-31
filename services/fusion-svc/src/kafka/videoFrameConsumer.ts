// A second, independent Kafka consumer for `{env}.vektor.video.frame`. Its
// messages are raw JPEG bytes with metadata in Kafka headers (see
// vektor-proto/src/schemas/video-frame.ts's header comment for why), not the
// JSON envelope ingestConsumers.ts's `eachMessage` unconditionally
// JSON.parses for every FUSION_DOMAINS topic — a single kafkajs Consumer
// instance can only run one eachMessage handler, so this can't be folded
// into that one. It also has no position to correlate on, so it never goes
// through the fusion/watermark pipeline (same reasoning DetectionEvent's
// header comment in observationMappers.ts documents for CV frames) — this
// just relays a throttled sample of frames straight to connected dashboards
// for a live camera view, independent of entity fusion entirely.
import type { Consumer, IHeaders } from "kafkajs";
import { topicName, type VektorEnv } from "@vektor/kafka";

export interface RelayedVideoFrame {
  sensorId: string;
  jpegBase64: string;
  frameNumber: number;
  width: number;
  height: number;
  capturedAt: string;
}

export interface VideoFrameConsumerOptions {
  consumer: Consumer;
  env: VektorEnv;
  /** Minimum ms between forwarded frames per sensor_id — the Kafka topic
   * runs at capture framerate (~15-30fps), which is both wasted bandwidth
   * and wasted render work for a dashboard thumbnail; this isn't meant to
   * be broadcast television. */
  minIntervalMs: number;
  onFrame: (frame: RelayedVideoFrame) => void;
  onError?: (err: Error) => void;
}

function headerString(headers: IHeaders | undefined, key: string): string | undefined {
  const value = headers?.[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0]?.toString() : value.toString();
}

export async function runVideoFrameConsumer(options: VideoFrameConsumerOptions): Promise<void> {
  const topic = topicName(options.env, "video", "frame");
  await options.consumer.subscribe({ topics: [topic], fromBeginning: false });

  const lastForwardedAt = new Map<string, number>();

  await options.consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      try {
        const sensorId = headerString(message.headers, "sensor_id");
        const frameNumber = Number(headerString(message.headers, "frame_number"));
        const width = Number(headerString(message.headers, "width"));
        const height = Number(headerString(message.headers, "height"));
        const capturedAt = headerString(message.headers, "sensor_ts");
        if (!sensorId || !capturedAt || !Number.isFinite(frameNumber) || !Number.isFinite(width) || !Number.isFinite(height)) {
          return;
        }

        const now = Date.now();
        const last = lastForwardedAt.get(sensorId) ?? 0;
        if (now - last < options.minIntervalMs) return;
        lastForwardedAt.set(sensorId, now);

        options.onFrame({ sensorId, jpegBase64: message.value.toString("base64"), frameNumber, width, height, capturedAt });
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
