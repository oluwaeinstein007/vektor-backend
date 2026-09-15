// Quick verification seed for the sensor-coverage feature: publishes one
// AIS and one ADS-B fix for sensors already registered via
// POST /api/v1/sensors, so their real sensor:status enrichment (position +
// coverage_radius_m from the registry) flows to any connected dashboard.
import { Kafka } from "kafkajs";
import { randomUUID } from "node:crypto";

const kafka = new Kafka({ clientId: "sensor-coverage-demo-seed", brokers: ["localhost:19092"] });
const producer = kafka.producer();
await producer.connect();

await producer.send({
  topic: "dev.vektor.ais.position",
  messages: [
    {
      key: "ais-receiver-01",
      value: JSON.stringify({
        event_id: randomUUID(),
        sensor_id: "ais-receiver-01",
        mmsi: "366123456",
        message_type: 1,
        nav_status: 0,
        lat: 37.8,
        lon: -122.42,
        speed_knots: 12,
        course_deg: 90,
        heading_deg: 90,
        sensor_ts: new Date().toISOString(),
        kafka_ts: new Date().toISOString(),
      }),
    },
  ],
});

await producer.send({
  topic: "dev.vektor.adsb.position",
  messages: [
    {
      key: "adsb-receiver-01",
      value: JSON.stringify({
        event_id: randomUUID(),
        sensor_id: "adsb-receiver-01",
        icao24: "A1B2C3",
        callsign: "TEST123",
        altitude_ft: 15000,
        ground_speed_kts: 250,
        track_deg: 180,
        lat: 37.7,
        lon: -122.3,
        vertical_rate_fpm: 0,
        squawk: "1200",
        on_ground: false,
        sensor_ts: new Date().toISOString(),
        kafka_ts: new Date().toISOString(),
      }),
    },
  ],
});

console.log("published AIS + ADS-B fixes for ais-receiver-01 / adsb-receiver-01");
await producer.disconnect();
