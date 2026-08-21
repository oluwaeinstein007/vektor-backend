// Generates a real, structurally valid GeoTIFF via `geotiff`'s own writer
// (a mature, independent write path within the same library) and confirms
// ingestGeoTiffFile's read/tag-extraction against it — this is the piece
// actually at risk of bugs, not GeoTIFF/TIFF encoding itself. See
// src/geotiff/ingestGeoTiff.ts's header comment for why gdal-async (the
// PRD's originally specified library) isn't installable in this sandbox.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as GeoTIFF from "geotiff";
import { Kafka, type Consumer, type Producer } from "kafkajs";
import { createKafkaClient, topicName } from "@vektor/kafka";
import { ingestGeoTiffFile } from "../src/geotiff/ingestGeoTiff.js";
import { watchGeoTiffInbox } from "../src/geotiff/watchInbox.js";
import type { GeoTiffIngestedEvent } from "@vektor/shared";

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const TOPIC = topicName("dev", "imagery", "ingested");

const WIDTH = 10;
const HEIGHT = 8;
const PIXEL_SCALE_DEG = 0.01;
const TOP_LEFT_LON = 10.0;
const TOP_LEFT_LAT = 50.0;

function buildTestGeoTiff(): ArrayBuffer {
  const data = new Uint8Array(WIDTH * HEIGHT).fill(128);
  return GeoTIFF.writeArrayBuffer(data, {
    width: WIDTH,
    height: HEIGHT,
    ModelPixelScale: [PIXEL_SCALE_DEG, PIXEL_SCALE_DEG, 0],
    ModelTiepoint: [0, 0, 0, TOP_LEFT_LON, TOP_LEFT_LAT, 0],
    GTModelTypeGeoKey: 2, // ModelTypeGeographic
    GeographicTypeGeoKey: 4326, // WGS84
  });
}

let tmpDir: string;
let kafka: Kafka;
let producer: Producer;
let consumer: Consumer;
const received: GeoTiffIngestedEvent[] = [];

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ingest-svc-geotiff-test-"));

  kafka = createKafkaClient({ clientId: `geotiff-test-${randomUUID()}`, brokers: KAFKA_BROKERS });
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }] });
  await admin.disconnect();

  consumer = kafka.consumer({ groupId: `geotiff-test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      received.push(JSON.parse(message.value.toString("utf-8")) as GeoTiffIngestedEvent);
    },
  });

  producer = kafka.producer();
  await producer.connect();
});

after(async () => {
  await producer.disconnect();
  await consumer.disconnect();
  await rm(tmpDir, { recursive: true, force: true });
});

test("ingestGeoTiffFile extracts correct bbox/dimensions/CRS and publishes to Kafka", async () => {
  const filePath = join(tmpDir, "scene-1.tif");
  await writeFile(filePath, Buffer.from(buildTestGeoTiff()));
  const sensorId = `test-geotiff-${randomUUID()}`;

  const event = await ingestGeoTiffFile(filePath, { producer, env: "dev", sensorId });

  assert.equal(event.file_name, "scene-1.tif");
  assert.equal(event.width_px, WIDTH);
  assert.equal(event.height_px, HEIGHT);
  assert.equal(event.band_count, 1);
  assert.equal(event.crs_epsg, 4326);
  assert.ok(Math.abs(event.bbox.min_lon - TOP_LEFT_LON) < 1e-9);
  assert.ok(Math.abs(event.bbox.max_lat - TOP_LEFT_LAT) < 1e-9);
  assert.ok(Math.abs(event.bbox.max_lon - (TOP_LEFT_LON + WIDTH * PIXEL_SCALE_DEG)) < 1e-9);
  assert.ok(Math.abs(event.bbox.min_lat - (TOP_LEFT_LAT - HEIGHT * PIXEL_SCALE_DEG)) < 1e-9);

  const deadline = Date.now() + 10_000;
  while (!received.some((e) => e.sensor_id === sensorId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const published = received.find((e) => e.sensor_id === sensorId);
  assert.ok(published, "expected the event to actually reach Kafka");
  assert.deepEqual(published, event);
});

test("watchGeoTiffInbox picks up a file dropped into the directory", async () => {
  const sensorId = `test-geotiff-watch-${randomUUID()}`;
  const ingested: GeoTiffIngestedEvent[] = [];
  const errors: Error[] = [];

  const handle = watchGeoTiffInbox(
    tmpDir,
    { producer, env: "dev", sensorId },
    (event) => ingested.push(event),
    (err) => errors.push(err),
    50, // short settle delay for the test
  );

  await writeFile(join(tmpDir, "dropped.tif"), Buffer.from(buildTestGeoTiff()));

  const deadline = Date.now() + 10_000;
  while (ingested.length < 1 && errors.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  handle.stop();
  assert.deepEqual(errors, []);
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0]!.file_name, "dropped.tif");
});

test("watchGeoTiffInbox ignores non-TIFF files", async () => {
  const sensorId = `test-geotiff-ignore-${randomUUID()}`;
  const ingested: GeoTiffIngestedEvent[] = [];

  const handle = watchGeoTiffInbox(
    tmpDir,
    { producer, env: "dev", sensorId },
    (event) => ingested.push(event),
    () => {},
    50,
  );

  await writeFile(join(tmpDir, "readme.txt"), "not a tiff");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  handle.stop();
  assert.equal(ingested.length, 0);
});
