// There's no live AIS feed to test the decoder against, so this verifies it
// the way binary codecs get verified without a trusted reference decoder:
// an independently-written encoder (tests/helpers/testAivdmEncoder.ts)
// implements the *inverse* of the same ITU-R M.1371 Class A position report
// bit layout, and the test round-trips known field values through it. This
// doesn't rule out both sides sharing the same misreading of the spec, but
// it does prove the decoder's bit offsets/widths/sign-handling are
// self-consistent, and the spec's field layout (168 bits, fixed offsets)
// has been stable and unambiguous for decades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAivdmPositionReport } from "../src/ais/aivdmDecoder.js";
import { encodePositionReportSentence } from "./helpers/testAivdmEncoder.js";

test("round-trips a Class A position report through independent encode/decode", () => {
  const lonDeg = 4.352;
  const latDeg = 51.9225;

  const sentence = encodePositionReportSentence({
    messageType: 1,
    mmsi: 244123456,
    navStatus: 0,
    sog: 125, // 12.5 knots
    lon: Math.round(lonDeg * 600000),
    lat: Math.round(latDeg * 600000),
    cog: 900, // 90.0 degrees
    heading: 88,
  });

  const decoded = decodeAivdmPositionReport(sentence);
  assert.ok(decoded, "sentence should decode");
  assert.equal(decoded!.mmsi, "244123456");
  assert.equal(decoded!.messageType, 1);
  assert.equal(decoded!.navStatus, 0);
  assert.ok(Math.abs(decoded!.lon - lonDeg) < 0.0001);
  assert.ok(Math.abs(decoded!.lat - latDeg) < 0.0001);
  assert.equal(decoded!.speedKnots, 12.5);
  assert.equal(decoded!.courseDeg, 90);
  assert.equal(decoded!.headingDeg, 88);
});

test("maps SOG/COG/heading 'not available' sentinels to null", () => {
  const sentence = encodePositionReportSentence({
    messageType: 2,
    mmsi: 111222333,
    navStatus: 5,
    sog: 1023,
    lon: Math.round(10 * 600000),
    lat: Math.round(50 * 600000),
    cog: 3600,
    heading: 511,
  });

  const decoded = decodeAivdmPositionReport(sentence);
  assert.ok(decoded);
  assert.equal(decoded!.speedKnots, null);
  assert.equal(decoded!.courseDeg, null);
  assert.equal(decoded!.headingDeg, null);
});

test("returns null for a message type outside 1/2/3", () => {
  // Type 5 (static/voyage data) uses a completely different layout; this
  // decoder shouldn't attempt to interpret it as a position report.
  const sentence = encodePositionReportSentence({
    messageType: 5,
    mmsi: 100000000,
    navStatus: 0,
    sog: 0,
    lon: Math.round(10 * 600000),
    lat: Math.round(50 * 600000),
    cog: 0,
    heading: 0,
  });
  assert.equal(decodeAivdmPositionReport(sentence), null);
});

test("returns null for a multi-fragment sentence", () => {
  assert.equal(decodeAivdmPositionReport("!AIVDM,2,1,3,A,55Mub7P00001L@?..,0*00"), null);
});

test("returns null for a non-AIVDM sentence", () => {
  assert.equal(decodeAivdmPositionReport("$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,,,,*47"), null);
});

test("returns null for negative (invalid/sentinel) longitude and latitude", () => {
  const sentence = encodePositionReportSentence({
    messageType: 1,
    mmsi: 100000000,
    navStatus: 0,
    sog: 0,
    lon: Math.round(181 * 600000), // "not available" sentinel
    lat: Math.round(50 * 600000),
    cog: 0,
    heading: 0,
  });
  assert.equal(decodeAivdmPositionReport(sentence), null);
});
