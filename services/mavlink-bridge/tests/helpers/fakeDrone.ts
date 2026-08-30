// A minimal, real MAVLink v2 UDP peer standing in for an ArduPilot/PX4
// SITL instance or a physical flight controller — sends genuine
// wire-format GLOBAL_POSITION_INT packets via node-mavlink's own encoder.
// Same "real local source, synthetic origin" pattern ingest-svc's AIS/ADS-B
// adapter tests already use (a real TCP server emitting real-format
// sentences stands in for hardware with no lightweight Docker equivalent).
import { MavEsp8266, common } from "node-mavlink";

export interface FakeDroneHandle {
  sendPosition: (lat: number, lon: number, altM: number, headingDeg: number) => Promise<void>;
  /** Sends GLOBAL_POSITION_INT with the raw wire-format hdg field (centidegrees, or 65535/UINT16_MAX for "unknown") — for exercising sentinel/edge-case decoding directly. */
  sendRawHeading: (lat: number, lon: number, altM: number, hdgRaw: number) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * @param bridgeReceivePort the port the mavlink-bridge under test listens on
 * @param bridgeSendPort the port the mavlink-bridge under test sends its Heartbeat to
 */
export async function startFakeDrone(bridgeReceivePort: number, bridgeSendPort: number): Promise<FakeDroneHandle> {
  // The drone's own receivePort is the bridge's sendPort, and vice versa —
  // the two peers face each other across the loopback link.
  const port = new MavEsp8266();
  await port.start(bridgeSendPort, bridgeReceivePort, "127.0.0.1");

  const sendRawHeading = async (lat: number, lon: number, altM: number, hdgRaw: number): Promise<void> => {
    const msg = new common.GlobalPositionInt();
    msg.timeBootMs = Date.now() >>> 0;
    msg.lat = Math.round(lat * 1e7);
    msg.lon = Math.round(lon * 1e7);
    msg.alt = Math.round(altM * 1000);
    msg.relativeAlt = msg.alt;
    msg.vx = 0;
    msg.vy = 0;
    msg.vz = 0;
    msg.hdg = hdgRaw;
    await port.send(msg, 1, 1);
  };

  return {
    sendPosition: (lat, lon, altM, headingDeg) => sendRawHeading(lat, lon, altM, Math.round(headingDeg * 100)),
    sendRawHeading,
    stop: () => port.close(),
  };
}
