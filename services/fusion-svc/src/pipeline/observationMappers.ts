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
import type { AisPositionReport, AdsbPositionReport, EwRfEmission } from "@vektor/shared";
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
