// Real Mosquitto broker, a real `mqtt` client standing in for the IoT
// device, and a real Kafka round trip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { Kafka, type Consumer, type Producer } from "kafkajs";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { startMqttAdapter } from "../src/mqtt/mqttAdapter.js";
import type { MqttAdapterHandle } from "../src/mqtt/mqttAdapter.js";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL ?? "mqtt://localhost:11883";
const TOPIC = topicName("dev", "iot", "telemetry");
const SENSOR_ID = `test-iot-${randomUUID()}`;
const DEVICE_TOPIC = `vektor/sensors/${SENSOR_ID}/telemetry`;

let kafka: Kafka;
let producer: Producer;
let consumer: Consumer;
let deviceClient: MqttClient;
let adapter: MqttAdapterHandle;

interface Received {
  value: Record<string, unknown>;
}
const received: Received[] = [];

before(async () => {
  kafka = createKafkaClient({ clientId: `mqtt-test-${randomUUID()}`, brokers: KAFKA_BROKERS });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  consumer = kafka.consumer({ groupId: `mqtt-test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const value = JSON.parse(message.value.toString("utf-8")) as Record<string, unknown>;
      if (value.sensor_id === SENSOR_ID) received.push({ value });
    },
  });

  producer = kafka.producer();
  await producer.connect();

  adapter = startMqttAdapter({
    brokerUrl: MQTT_BROKER_URL,
    topicFilter: "vektor/sensors/#",
    producer,
    env: "dev",
    sensorId: SENSOR_ID,
    onError: (err) => {
      throw err;
    },
  });

  deviceClient = mqtt.connect(MQTT_BROKER_URL);
  await new Promise<void>((resolve) => deviceClient.on("connect", () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 500)); // let the adapter finish subscribing
});

after(async () => {
  await adapter.stop();
  await new Promise<void>((resolve) => deviceClient.end(false, {}, () => resolve()));
  await producer.disconnect();
  await consumer.disconnect();
});

test("republishes a device's MQTT telemetry to Kafka as an IotTelemetryEvent", async () => {
  deviceClient.publish(DEVICE_TOPIC, JSON.stringify({ temperature_c: 21.5, battery_pct: 87 }));

  const deadline = Date.now() + 10_000;
  while (received.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(received.length, 1);
  const event = received[0]!.value;
  assert.equal(event.mqtt_topic, DEVICE_TOPIC);
  assert.deepEqual(event.payload, { temperature_c: 21.5, battery_pct: 87 });
  assert.ok(!Number.isNaN(Date.parse(event.sensor_ts as string)));
});

test("rejects a non-JSON payload without crashing the adapter", async () => {
  const errors: Error[] = [];
  const isolatedSensorId = `test-iot-bad-${randomUUID()}`;
  const isolatedAdapter = startMqttAdapter({
    brokerUrl: MQTT_BROKER_URL,
    topicFilter: "vektor/bad/#",
    producer,
    env: "dev",
    sensorId: isolatedSensorId,
    onError: (err) => errors.push(err),
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  deviceClient.publish("vektor/bad/topic", "not json");

  const deadline = Date.now() + 5_000;
  while (errors.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /not valid JSON/);
  await isolatedAdapter.stop();
});
