// ML-003: consumes raw video frames (SVC-001's {env}.vektor.video.frame),
// runs YOLOv8 inference + DeepSORT tracking, and publishes tracked
// detections to {env}.vektor.detection.tracked.
import { randomUUID } from "node:crypto";
import type { Consumer, Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { DetectionEvent } from "@vektor/shared";
import { DetectionModel } from "../inference/session.js";
import { preprocessFrame } from "../inference/preprocess.js";
import { decodeYoloOutput } from "../inference/postprocess.js";
import { DeepSortTracker } from "../tracker/deepSortTracker.js";

export interface ProcessFramesOptions {
  consumer: Consumer;
  producer: Producer;
  model: DetectionModel;
  classNames: string[];
  env: VektorEnv;
  confidenceThreshold?: number;
  onDetections?: (events: DetectionEvent[]) => void;
  onError?: (err: Error) => void;
}

export function detectionTopic(env: VektorEnv): string {
  return topicName(env, "detection", "tracked");
}

export async function runFrameConsumer(options: ProcessFramesOptions): Promise<void> {
  const inTopic = topicName(options.env, "video", "frame");
  const outTopic = detectionTopic(options.env);
  // One tracker per sensor stream — tracking state (persistent IDs,
  // Kalman filters) must not be shared across independent camera feeds.
  const trackersBySensor = new Map<string, DeepSortTracker>();

  await options.consumer.subscribe({ topic: inTopic, fromBeginning: false });
  await options.consumer.run({
    eachMessage: async ({ message }) => {
      try {
        if (!message.value) return;

        const headers = Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([key, value]) => [key, value?.toString() ?? ""]),
        );
        const sensorId = headers.sensor_id;
        const frameId = headers.frame_id;
        const sensorTs = headers.sensor_ts;
        if (!sensorId || !frameId || !sensorTs) return;

        const preprocessed = await preprocessFrame(message.value);
        const rawOutput = await options.model.infer(preprocessed.tensorData, preprocessed.targetSize);
        const detections = decodeYoloOutput(
          rawOutput,
          preprocessed,
          options.classNames,
          options.confidenceThreshold ?? 0.25,
        );

        let tracker = trackersBySensor.get(sensorId);
        if (!tracker) {
          tracker = new DeepSortTracker();
          trackersBySensor.set(sensorId, tracker);
        }

        const tracked = tracker.step(
          detections.map((d) => ({ bbox: d.bbox, classification: d.className, confidence: d.confidence })),
        );

        const now = new Date();
        const events: DetectionEvent[] = tracked.map((t) => ({
          event_id: randomUUID(),
          frame_id: frameId,
          sensor_id: sensorId,
          track_id: t.trackId,
          class: t.classification,
          bbox: [
            t.bbox.cx - t.bbox.w / 2,
            t.bbox.cy - t.bbox.h / 2,
            t.bbox.cx + t.bbox.w / 2,
            t.bbox.cy + t.bbox.h / 2,
          ],
          confidence: t.confidence,
          velocity_px_per_frame: { vx: t.velocity.vx, vy: t.velocity.vy },
          heading_deg: t.headingDeg,
          sensor_ts: sensorTs,
          kafka_ts: now.toISOString(),
        }));

        for (const event of events) {
          assertValidSensorTs(event.sensor_ts, event.sensor_id, now);
          DetectionEvent.parse(event);
        }

        if (events.length > 0) {
          await options.producer.send({
            topic: outTopic,
            messages: events.map((event) => ({ key: event.sensor_id, value: JSON.stringify(event) })),
          });
        }

        options.onDetections?.(events);
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });
}
