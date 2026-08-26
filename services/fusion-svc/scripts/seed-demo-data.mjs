// One-off demo seed: publishes a handful of AIS/ADS-B/EW-RF messages to the
// same Kafka topics fusion-svc's ingestConsumers.ts consumes from, so
// entities appear on the dashboard through the real fusion pipeline (no
// mocked data, no direct DB writes) — matching this project's "verify
// against real infra" convention.
import { Kafka } from "kafkajs";
import { randomUUID } from "node:crypto";

const KAFKA_BROKERS = ["localhost:19092"];
const ENV = "dev";

const kafka = new Kafka({ clientId: "demo-seed", brokers: KAFKA_BROKERS });
const producer = kafka.producer();

function topic(domain, action) {
  return `${ENV}.vektor.${domain}.${action}`;
}

const now = () => new Date().toISOString();

const aisMessages = [
  {
    event_id: randomUUID(),
    sensor_id: "ais-receiver-01",
    mmsi: "366123456",
    message_type: 1,
    nav_status: 0,
    lat: 37.78,
    lon: -122.41,
    speed_knots: 12.4,
    course_deg: 95,
    heading_deg: 94,
    sensor_ts: now(),
    kafka_ts: now(),
  },
  {
    event_id: randomUUID(),
    sensor_id: "ais-receiver-01",
    mmsi: "366987654",
    message_type: 1,
    nav_status: 0,
    lat: 37.7,
    lon: -122.38,
    speed_knots: 8.1,
    course_deg: 210,
    heading_deg: 208,
    sensor_ts: now(),
    kafka_ts: now(),
  },
  {
    event_id: randomUUID(),
    sensor_id: "ais-receiver-02",
    mmsi: "367112233",
    message_type: 1,
    nav_status: 0,
    lat: 37.62,
    lon: -122.5,
    speed_knots: 15.6,
    course_deg: 30,
    heading_deg: 32,
    sensor_ts: now(),
    kafka_ts: now(),
  },
];

const adsbMessages = [
  {
    event_id: randomUUID(),
    sensor_id: "adsb-receiver-01",
    icao24: "A1B2C3",
    callsign: "UAL245",
    altitude_ft: 34000,
    ground_speed_kts: 480,
    track_deg: 270,
    lat: 37.9,
    lon: -122.6,
    vertical_rate_fpm: 0,
    squawk: "1200",
    on_ground: false,
    sensor_ts: now(),
    kafka_ts: now(),
  },
  {
    event_id: randomUUID(),
    sensor_id: "adsb-receiver-01",
    icao24: "D4E5F6",
    callsign: "SWA812",
    altitude_ft: 12000,
    ground_speed_kts: 320,
    track_deg: 140,
    lat: 37.55,
    lon: -122.3,
    vertical_rate_fpm: -800,
    squawk: "4512",
    on_ground: false,
    sensor_ts: now(),
    kafka_ts: now(),
  },
];

const ewrfMessages = [
  {
    event_id: randomUUID(),
    sensor_id: "ewrf-array-01",
    freq_mhz: 9410,
    bearing_deg: 128,
    signal_strength_dbm: -42,
    modulation: "PULSE",
    emitter_classification: "RadarType.Search",
    sensor_position: { lat: 37.75, lon: -122.45 },
    estimated_position: { lat: 37.68, lon: -122.28, accuracy_m: 4500 },
    sensor_ts: now(),
    kafka_ts: now(),
  },
];

const FUSION_SVC_URL = "http://localhost:3007";

const blueForceAssets = [
  {
    callsign: "OUTPOST-1",
    classification: "Base.Friendly",
    position: { lat: 37.75, lon: -122.45, alt_m: 0 },
    buffer_radius_m: 3000,
  },
  {
    callsign: "FOB-EAGLE",
    classification: "Base.Friendly",
    position: { lat: 37.95, lon: -122.3, alt_m: 0 },
    buffer_radius_m: 2000,
  },
];

async function seedBlueForceAssets() {
  const res = await fetch(`${FUSION_SVC_URL}/api/v1/blue-force-assets`);
  const existing = new Set((await res.json()).map((a) => a.callsign));

  for (const asset of blueForceAssets) {
    if (existing.has(asset.callsign)) {
      console.log(`blue-force asset ${asset.callsign} already exists, skipping`);
      continue;
    }
    await fetch(`${FUSION_SVC_URL}/api/v1/blue-force-assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(asset),
    });
    console.log(`created blue-force asset ${asset.callsign} (+ its auto no-strike buffer)`);
  }
}

async function main() {
  await seedBlueForceAssets();

  await producer.connect();

  const records = [
    { topic: topic("ais", "position"), messages: aisMessages.map((m) => ({ value: JSON.stringify(m) })) },
    { topic: topic("adsb", "position"), messages: adsbMessages.map((m) => ({ value: JSON.stringify(m) })) },
    { topic: topic("ewrf", "emission"), messages: ewrfMessages.map((m) => ({ value: JSON.stringify(m) })) },
  ];

  for (const record of records) {
    await producer.send(record);
    console.log(`published ${record.messages.length} message(s) to ${record.topic}`);
  }

  await producer.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
