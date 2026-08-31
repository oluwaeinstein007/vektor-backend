// Wires the RTSP/SRT frame extractor to the Kafka publisher. Separated from
// index.ts's process/env-var concerns for the same reason geospatial-svc
// splits app.ts from index.ts: tests can drive this against a real ffmpeg
// process and a real Kafka producer without needing env vars or signal
// handlers wired up.
import type { Producer } from "kafkajs";
import type { VektorEnv } from "@vektor/kafka";
import {
  extractFrames,
  type ExtractedFrame,
  type FrameExtractorHandle,
  type FrameRotation,
} from "./rtsp/frameExtractor.js";
import { publishFrame } from "./kafka/publishFrame.js";

export interface RunIngestOptions {
  sourceUrl: string;
  rtspTransport?: "tcp" | "udp";
  rotation?: FrameRotation;
  producer: Producer;
  env: VektorEnv;
  sensorId: string;
  onPublished?: (frame: ExtractedFrame) => void;
  onFrameError?: (err: Error) => void;
}

export function runIngest(options: RunIngestOptions): FrameExtractorHandle {
  return extractFrames(
    { sourceUrl: options.sourceUrl, rtspTransport: options.rtspTransport, rotation: options.rotation },
    (frame) => {
      // Fire-and-forget per frame rather than awaiting inside the `data`
      // handler: blocking here would apply backpressure straight to the
      // ffmpeg pipe and risk falling behind REQ-1.1's >=30fps target. A
      // publish failure is reported via onFrameError, not thrown.
      publishFrame(frame, { producer: options.producer, env: options.env, sensorId: options.sensorId })
        .then(() => options.onPublished?.(frame))
        .catch((err: unknown) => options.onFrameError?.(err instanceof Error ? err : new Error(String(err))));
    },
    (err) => options.onFrameError?.(err),
  );
}
