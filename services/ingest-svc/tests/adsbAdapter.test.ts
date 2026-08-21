// Real TCP server standing in for a dump1090-class SBS-1 feed, real socket,
// real Kafka round trip — same testing shape as aisAdapter.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { Kafka, type Consumer, type Producer } from "kafkajs";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { startAdsbAdapter } from "../src/adsb/adsbAdapter.js";
import type { AdsbAdapterHandle } from "../src/adsb/adsbAdapter.js";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const TOPIC = topicName("dev", "adsb", "position");
const SENSOR_ID = `test-adsb-${randomUUID()}`;

// A real-format SBS-1 airborne-position line (MSG,3), per the documented
// BaseStation column layout — see src/adsb/sbs1Parser.ts's comment.
const POSITION_LINE =
  "MSG,3,1,1,4CA87C,1,2026/08/21,04:00:00.000,2026/08/21,04:00:00.000,,38000,,,51.4700,-0.4543,,,,,,0";
// An identification-only line (MSG,1) — no position, has a callsign.
const IDENTIFICATION_LINE =
  "MSG,1,1,1,4CA87C,1,2026/08/21,04:00:01.000,2026/08/21,04:00:01.000,BAW123  ,,,,,,,,,,,0";

let server: Server;
let serverPort: number;
let clientSocket: Socket | undefined;
let kafka: Kafka;
let producer: Producer;
let consumer: Consumer;
let adapter: AdsbAdapterHandle;

interface Received {
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

  kafka = createKafkaClient({ clientId: `adsb-test-${randomUUID()}`, brokers: KAFKA_BROKERS });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  consumer = kafka.consumer({ groupId: `adsb-test-${randomUUID()}` });
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

  adapter = startAdsbAdapter({
    host: "127.0.0.1",
    port: serverPort,
    producer,
    env: "dev",
    sensorId: SENSOR_ID,
    onError: (err) => {
      throw err;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
});

after(async () => {
  adapter.stop();
  server.close();
  await producer.disconnect();
  await consumer.disconnect();
});

test("parses SBS-1 position and identification lines and publishes both to Kafka", async () => {
  assert.ok(clientSocket, "adapter should have connected to the test SBS-1 server");
  clientSocket!.write(`${POSITION_LINE}\r\n`);
  clientSocket!.write(`${IDENTIFICATION_LINE}\r\n`);

  const deadline = Date.now() + 10_000;
  while (received.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  assert.equal(received.length, 2);

  const position = received.find((r) => r.value.lat !== null);
  assert.ok(position, "expected the MSG,3 line to carry a position");
  assert.equal(position!.value.icao24, "4CA87C");
  assert.equal(position!.value.lat, 51.47);
  assert.equal(position!.value.lon, -0.4543);
  assert.equal(position!.value.altitude_ft, 38000);
  assert.equal(position!.value.on_ground, false);

  const identification = received.find((r) => r.value.callsign !== null);
  assert.ok(identification, "expected the MSG,1 line to carry a callsign");
  assert.equal(identification!.value.callsign, "BAW123");
  assert.equal(identification!.value.lat, null);
});
