// Parses the SBS-1 (BaseStation) CSV line format — the de facto standard
// text feed emitted by dump1090-class ADS-B receivers on TCP port 30003.
// This is a plain-text adapter, not a Mode S/RF decoder: REQ-1.5 calls
// SVC-003 an "adapter" for an already-decoded feed, matching how SVC-002
// consumes GeoTIFF files rather than raw SAR sensor returns.
export interface DecodedAdsbMessage {
  icao24: string;
  messageType: number;
  callsign: string | null;
  altitudeFt: number | null;
  groundSpeedKts: number | null;
  trackDeg: number | null;
  lat: number | null;
  lon: number | null;
  verticalRateFpm: number | null;
  squawk: string | null;
  onGround: boolean;
}

function numOrNull(s: string | undefined): number | null {
  return s && s.length > 0 ? Number(s) : null;
}

function strOrNull(s: string | undefined): string | null {
  const trimmed = s?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

// Column layout (0-indexed after split(",")):
// 0 MSG, 1 transmission type, 2 session id, 3 aircraft id, 4 hex ident,
// 5 flight id, 6 date generated, 7 time generated, 8 date logged,
// 9 time logged, 10 callsign, 11 altitude, 12 ground speed, 13 track,
// 14 lat, 15 lon, 16 vertical rate, 17 squawk, 18 alert, 19 emergency,
// 20 SPI, 21 is-on-ground.
export function parseSbs1Line(line: string): DecodedAdsbMessage | null {
  const fields = line.trim().split(",");
  if (fields[0] !== "MSG" || fields.length < 22) return null;

  const hex = fields[4];
  if (!hex) return null;

  return {
    icao24: hex.toUpperCase(),
    messageType: Number(fields[1]),
    callsign: strOrNull(fields[10]),
    altitudeFt: numOrNull(fields[11]),
    groundSpeedKts: numOrNull(fields[12]),
    trackDeg: numOrNull(fields[13]),
    lat: numOrNull(fields[14]),
    lon: numOrNull(fields[15]),
    verticalRateFpm: numOrNull(fields[16]),
    squawk: strOrNull(fields[17]),
    // SBS-1's boolean columns use the VB6/Access convention: "-1" is true.
    onGround: fields[21] === "-1",
  };
}
