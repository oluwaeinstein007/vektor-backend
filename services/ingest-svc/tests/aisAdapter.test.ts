// A real TCP server standing in for an AIS feed (there's no way to get real
// AIS RF hardware in this sandbox), a real socket connection, and a real
// Kafka round trip — only the "AIS receiver" side is synthetic, the same
// boundary SVC-001's tests draw around the RTSP source.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Kafka, type Consumer, type Producer } from "kafkajs";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { startAisAdapter } from "../src/ais/aisAdapter.js";
import type { AisAdapterHandle } from "../src/ais/aisAdapter.js";
import { encodePositionReportSentence } from "./helpers/testAivdmEncoder.js";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const TOPIC = topicName("dev", "ais", "position");
const SENSOR_ID = `test-ais-${randomUUID()}`;

const SAMPLE_LON = 4.352;
const SAMPLE_LAT = 51.9225;
const SAMPLE_SENTENCE = encodePositionReportSentence({
  messageType: 1,
  mmsi: 244123456,
  navStatus: 0,
  sog: 125, // 12.5 knots
  lon: Math.round(SAMPLE_LON * 600000),
  lat: Math.round(SAMPLE_LAT * 600000),
  cog: 900, // 90.0 degrees
  heading: 88,
});

let server: Server;
let serverPort: number;
let clientSocket: Socket | undefined;
let kafka: Kafka;
let producer: Producer;
let consumer: Consumer;
let adapter: AisAdapterHandle;

interface Received {
  key: string | null;
  value: Record<string, unknown>;
}
const received: Received[] = [];

before(async () => {
  server = createServer((socket) => {
    clientSocket = socket;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
  serverPort = address.port;

  kafka = createKafkaClient({ clientId: `ais-test-${randomUUID()}`, brokers: KAFKA_BROKERS });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  consumer = kafka.consumer({ groupId: `ais-test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const value = JSON.parse(message.value.toString("utf-8")) as Record<string, unknown>;
      if (value.sensor_id === SENSOR_ID) {
        received.push({ key: message.key?.toString() ?? null, value });
      }
    },
  });

  producer = kafka.producer();
  await producer.connect();

  adapter = startAisAdapter({
    host: "127.0.0.1",
    port: serverPort,
    producer,
    env: "dev",
    sensorId: SENSOR_ID,
    onError: (err) => {
      throw err;
    },
  });

  // Give the adapter's socket time to connect before the test writes to it.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

after(async () => {
  adapter.stop();
  server.close();
  await producer.disconnect();
  await consumer.disconnect();
});

test("decodes a live-fed AIVDM sentence and publishes it to Kafka", async () => {
  assert.ok(clientSocket, "adapter should have connected to the test AIS server");
  clientSocket!.write(`${SAMPLE_SENTENCE}\r\n`);
  // A non-AIVDM line on the same feed (e.g. a GPS NMEA sentence sharing the
  // wire) should be silently skipped, not crash the adapter or publish junk.
  clientSocket!.write("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,,,,*47\r\n");

  const deadline = Date.now() + 10_000;
  while (received.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(received.length, 1);
  const event = received[0]!;
  assert.equal(event.key, SENSOR_ID);
  assert.equal(event.value.mmsi, "244123456");
  assert.equal(event.value.message_type, 1);
  assert.ok(Math.abs((event.value.lon as number) - SAMPLE_LON) < 0.0001);
  assert.ok(Math.abs((event.value.lat as number) - SAMPLE_LAT) < 0.0001);
  assert.equal(event.value.speed_knots, 12.5);
});
