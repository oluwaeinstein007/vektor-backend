// Test-only encoder — the inverse of src/ais/aivdmDecoder.ts's bit layout,
// written independently so decoder tests aren't tautological against a
// shared implementation. See tests/aivdmDecoder.test.ts for the rationale.
// Shared by aivdmDecoder.test.ts and aisAdapter.test.ts so a real (verified
// by the round-trip test) sentence is generated, rather than a hand-typed
// payload string nobody can easily eyeball-verify.
import assert from "node:assert/strict";

function toBinary(value: number, length: number): string {
  const normalized = value < 0 ? value + 2 ** length : value;
  return normalized.toString(2).padStart(length, "0");
}

function bitsToSixBitAscii(bits: string): string {
  const padded = bits.padEnd(Math.ceil(bits.length / 6) * 6, "0");
  let payload = "";
  for (let i = 0; i < padded.length; i += 6) {
    const value = parseInt(padded.slice(i, i + 6), 2);
    payload += String.fromCharCode(value < 40 ? value + 48 : value + 56);
  }
  return payload;
}

export interface PositionReportFields {
  messageType: number;
  mmsi: number;
  navStatus: number;
  sog: number; // raw 0.1-knot units
  lon: number; // raw 1/600000-degree units
  lat: number;
  cog: number; // raw 0.1-degree units
  heading: number;
}

export function encodePositionReportSentence(fields: PositionReportFields): string {
  const bits =
    toBinary(fields.messageType, 6) +
    toBinary(0, 2) + // repeat indicator
    toBinary(fields.mmsi, 30) +
    toBinary(fields.navStatus, 4) +
    toBinary(0, 8) + // rate of turn
    toBinary(fields.sog, 10) +
    toBinary(1, 1) + // position accuracy
    toBinary(fields.lon, 28) +
    toBinary(fields.lat, 27) +
    toBinary(fields.cog, 12) +
    toBinary(fields.heading, 9) +
    toBinary(0, 6) + // timestamp
    toBinary(0, 2) + // maneuver indicator
    toBinary(0, 3) + // spare
    toBinary(0, 1) + // RAIM
    toBinary(0, 19); // radio status

  assert.equal(bits.length, 168, "Class A position report must be exactly 168 bits");
  return `!AIVDM,1,1,,A,${bitsToSixBitAscii(bits)},0*00`;
}
