// SVC-003 (REQ-1.5): subscribes to an MQTT broker and republishes every
// message onto Kafka as an IotTelemetryEvent. The payload is passed through
// as parsed JSON rather than normalized to a device-specific schema — IoT
// telemetry shapes vary per device class, and forcing one canonical shape
// here would just push the normalization problem downstream anyway.
import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { IotTelemetryEvent } from "@vektor/shared";

export interface MqttAdapterOptions {
  brokerUrl: string;
  topicFilter: string;
  producer: Producer;
  env: VektorEnv;
  sensorId: string;
  onPublished?: (event: IotTelemetryEvent) => void;
  onError?: (err: Error) => void;
}

export interface MqttAdapterHandle {
  client: MqttClient;
  stop: () => Promise<void>;
}

export function startMqttAdapter(options: MqttAdapterOptions): MqttAdapterHandle {
  const client = mqtt.connect(options.brokerUrl);

  client.on("connect", () => {
    client.subscribe(options.topicFilter, (err) => {
      if (err) options.onError?.(err);
    });
  });

  client.on("error", (err) => options.onError?.(err));

  client.on("message", (mqttTopic, payloadBuffer) => {
    void handleMessage(mqttTopic, payloadBuffer, options);
  });

  return {
    client,
    stop: () => new Promise<void>((resolve) => client.end(false, {}, () => resolve())),
  };
}

async function handleMessage(mqttTopic: string, payloadBuffer: Buffer, options: MqttAdapterOptions): Promise<void> {
  try {
    const now = new Date();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadBuffer.toString("utf-8")) as Record<string, unknown>;
    } catch {
      throw new Error(`payload on MQTT topic "${mqttTopic}" is not valid JSON`);
    }

    // A device with its own synced clock reports its own sensor_ts; a device
    // that doesn't gets stamped with receipt time — better than rejecting
    // its telemetry outright, since REQ-1.5's IoT/MQTT class covers simple
    // devices that may have no RTC at all.
    const sensorTs = typeof payload.sensor_ts === "string" ? payload.sensor_ts : now.toISOString();

    const event: IotTelemetryEvent = {
      event_id: randomUUID(),
      sensor_id: options.sensorId,
      mqtt_topic: mqttTopic,
      payload,
      sensor_ts: sensorTs,
      kafka_ts: new Date().toISOString(),
    };

    assertValidSensorTs(event.sensor_ts, event.sensor_id, now);
    IotTelemetryEvent.parse(event);

    await options.producer.send({
      topic: topicName(options.env, "iot", "telemetry"),
      messages: [{ key: options.sensorId, value: JSON.stringify(event) }],
    });

    options.onPublished?.(event);
  } catch (err) {
    options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
