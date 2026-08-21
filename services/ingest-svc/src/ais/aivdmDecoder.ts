// Decodes an !AIVDM sentence carrying a Class A position report (ITU-R
// M.1371 message types 1/2/3, the "position report" class of message —
// REQ-1.5). This intentionally does not implement the full AIS message set
// (static/voyage data, Class B, base station reports, ...) — just the one
// message class that produces live position updates, matching what SVC-003
// actually needs. Multi-fragment sentence reassembly is also out of scope:
// Class A position reports always fit in a single 168-bit/28-char fragment,
// so only 1-fragment sentences are handled.
//
// NMEA checksum (the `*XX` suffix) is not validated — this decoder trusts
// the transport layer (TCP-delivered AIS feeds are the common real-world
// case) rather than re-implementing NMEA's XOR checksum on top of it.

export interface DecodedAisPosition {
  mmsi: string;
  messageType: 1 | 2 | 3;
  navStatus: number;
  lat: number;
  lon: number;
  speedKnots: number | null;
  courseDeg: number | null;
  headingDeg: number | null;
}

// "Not available" sentinel values per the ITU-R M.1371 field encoding.
const SENTINEL_LON_DEG = 181;
const SENTINEL_LAT_DEG = 91;
const SENTINEL_SOG_RAW = 1023; // 0.1-knot units
const SENTINEL_COG_RAW = 3600; // 0.1-degree units
const SENTINEL_HEADING_RAW = 511;

/**
 * AIS's 6-bit ASCII armor: valid characters are '0'-'W' (ASCII 48-87,
 * values 0-39) and '`'-'w' (ASCII 96-119, values 40-63) — ASCII 88-95
 * ('X'-'_') are deliberately unused, which is what keeps this formula
 * unambiguous instead of colliding two different characters onto one value.
 */
function sixBitAsciiToBits(payload: string): string {
  let bits = "";
  for (const char of payload) {
    let value = char.charCodeAt(0) - 48;
    if (value > 40) value -= 8;
    bits += value.toString(2).padStart(6, "0");
  }
  return bits;
}

function readUint(bits: string, offset: number, length: number): number {
  return parseInt(bits.slice(offset, offset + length), 2);
}

// Two's-complement signed read, done via parseInt + arithmetic rather than
// bitwise operators so fields wider than 31 bits (not needed here, but the
// pattern is worth keeping consistent) don't silently truncate.
function readInt(bits: string, offset: number, length: number): number {
  const raw = readUint(bits, offset, length);
  const max = 2 ** length;
  return raw >= max / 2 ? raw - max : raw;
}

export function decodeAivdmPositionReport(sentence: string): DecodedAisPosition | null {
  const trimmed = sentence.trim();
  if (!trimmed.startsWith("!AIVDM") && !trimmed.startsWith("!AIVDO")) return null;

  const fields = trimmed.split("*")[0]?.split(",");
  if (!fields || fields.length < 6) return null;

  const fragmentCount = Number(fields[1]);
  const payload = fields[5];
  if (fragmentCount !== 1 || !payload) return null;

  const bits = sixBitAsciiToBits(payload);
  if (bits.length < 168) return null;

  const messageType = readUint(bits, 0, 6);
  if (messageType !== 1 && messageType !== 2 && messageType !== 3) return null;

  const mmsi = readUint(bits, 8, 30);
  const navStatus = readUint(bits, 38, 4);
  const sogRaw = readUint(bits, 50, 10);
  const lonRaw = readInt(bits, 61, 28);
  const latRaw = readInt(bits, 89, 27);
  const cogRaw = readUint(bits, 116, 12);
  const headingRaw = readUint(bits, 128, 9);

  const lon = lonRaw / 600000;
  const lat = latRaw / 600000;
  if (Math.abs(lon) >= SENTINEL_LON_DEG || Math.abs(lat) >= SENTINEL_LAT_DEG) return null;

  return {
    mmsi: mmsi.toString().padStart(9, "0"),
    messageType: messageType as 1 | 2 | 3,
    navStatus,
    lat,
    lon,
    speedKnots: sogRaw === SENTINEL_SOG_RAW ? null : sogRaw / 10,
    courseDeg: cogRaw === SENTINEL_COG_RAW ? null : cogRaw / 10,
    headingDeg: headingRaw === SENTINEL_HEADING_RAW ? null : headingRaw,
  };
}
