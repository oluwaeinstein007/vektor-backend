// Converts each domain's wire event into the domain-agnostic TrackObservation
// TrackManager.correlate() consumes. This is the "unified ontology" half of
// REQ-3.1 that happens before correlation — every sensor modality speaks
// TrackObservation from here on, regardless of its own wire shape.
//
// CV DetectionEvent (`detection.tracked`) deliberately has no mapper here:
// it carries only image-space bbox/velocity (see vektor-proto's
// DetectionEvent doc comment), and no service in this system geo-registers
// a camera to real-world coordinates. It still flows through SVC-007's
// Kafka-consumer + Redis-Streams topology (see kafka/ingestConsumers.ts) so
// the pipeline is ready to fuse it the moment a future phase adds that
// registration step, but it can't produce a TrackObservation today.
import type { AisPositionReport, AdsbPositionReport, EwRfEmission, IotTelemetryEvent } from "@vektor/shared";
import { MavlinkTelemetryPayload, FieldPhoneTelemetryPayload } from "@vektor/shared";
import type { TrackObservation } from "./trackManager.js";

const FEET_TO_METERS = 0.3048;

export function fromAis(event: AisPositionReport): TrackObservation {
  return {
    domain: "ais",
    sensor_id: event.sensor_id,
    position: { lat: event.lat, lon: event.lon, alt_m: 0 },
    classification: "Vessel.AIS",
    affiliation: "UNKNOWN",
    confidence: 0.9, // GPS-derived Class A position report
    sensor_ts: event.sensor_ts,
  };
}

export function fromAdsb(event: AdsbPositionReport): TrackObservation | null {
  if (event.lat === null || event.lon === null) return null; // report without a resolved position fix
  return {
    domain: "adsb",
    sensor_id: event.sensor_id,
    position: { lat: event.lat, lon: event.lon, alt_m: (event.altitude_ft ?? 0) * FEET_TO_METERS },
    classification: "Aircraft.ADSB",
    affiliation: "UNKNOWN",
    confidence: 0.9,
    sensor_ts: event.sensor_ts,
  };
}

export function fromEwRf(event: EwRfEmission): TrackObservation | null {
  if (!event.estimated_position) return null; // bearing-only fix — no position to correlate on yet
  return {
    domain: "ewrf",
    sensor_id: event.sensor_id,
    position: { lat: event.estimated_position.lat, lon: event.estimated_position.lon, alt_m: 0 },
    classification: event.emitter_classification ?? "Emitter.Unclassified",
    affiliation: "UNKNOWN",
    confidence: 0.4, // single-receiver RF geolocation is inherently low-confidence
    sensor_ts: event.sensor_ts,
  };
}

// IotTelemetryEvent.payload is intentionally unstructured (arbitrary IoT
// device shapes) — most MQTT devices publishing onto this topic have no
// known correlatable position contract, so most payloads legitimately can't
// produce a TrackObservation. A MAVLink-sourced payload (mavlink-bridge) and
// a field-pwa phone payload (ingest-svc's HTTP field-ingest endpoint) are
// the two recognized device classes today, both discriminated by
// payload.device_class; any other payload shape is silently skipped here,
// same as fromAdsb skipping a no-fix report.
export function fromIot(event: IotTelemetryEvent): TrackObservation | null {
  const mavlink = MavlinkTelemetryPayload.safeParse(event.payload);
  if (mavlink.success) {
    const { data } = mavlink;
    return {
      domain: "iot",
      sensor_id: event.sensor_id,
      position: { lat: data.lat, lon: data.lon, alt_m: data.alt_m },
      classification: "UAS.MAVLink",
      // Our own operated telemetry, not passive third-party sensing like
      // AIS/ADS-B/EW-RF — a MAVLink feed we're bridging is presumed friendly.
      affiliation: "FRIENDLY",
      confidence: 0.95, // direct GPS-derived flight-controller telemetry
      sensor_ts: event.sensor_ts,
    };
  }

  const phone = FieldPhoneTelemetryPayload.safeParse(event.payload);
  if (phone.success) {
    const { data } = phone;
    return {
      domain: "iot",
      sensor_id: event.sensor_id,
      position: { lat: data.lat, lon: data.lon, alt_m: data.alt_m },
      classification: "Personnel.FieldOperator",
      // A field-pwa phone is our own operator's device, not passive
      // third-party sensing — same "we're bridging our own telemetry"
      // reasoning as the MAVLink case above.
      affiliation: "FRIENDLY",
      confidence: 0.85, // consumer-phone GPS — less precise than a flight controller's
      sensor_ts: event.sensor_ts,
    };
  }

  return null;
}
