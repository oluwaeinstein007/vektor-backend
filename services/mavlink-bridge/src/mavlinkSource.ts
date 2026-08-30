// Reads GLOBAL_POSITION_INT off a MAVLink v1/v2 UDP link (the standard
// transport for ArduPilot/PX4 SITL's `--out udpin:` and most
// companion-computer telemetry radios) and normalizes it to plain
// lat/lon/alt/heading/groundspeed. GLOBAL_POSITION_INT alone carries
// everything MavlinkTelemetryPayload needs, so there's no reason to also
// track ATTITUDE.
import { MavEsp8266, common, minimal, type MavLinkPacket } from "node-mavlink";

const REGISTRY = { ...minimal.REGISTRY, ...common.REGISTRY };
const HDG_UNKNOWN = 65535; // UINT16_MAX sentinel for "unknown heading" per common.xml

export interface MavlinkTelemetryTick {
  systemId: number;
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number | null;
  groundspeedMps: number;
}

export interface MavlinkSourceOptions {
  /** Port this bridge listens on for incoming telemetry (default: 14550, matching MavEsp8266/typical GCS convention). */
  receivePort?: number;
  /** Port this bridge sends its own Heartbeat to (default: 14555, matching ArduPilot SITL's `--out udpin:127.0.0.1:14555`). */
  sendPort?: number;
  /** Target IP for outbound sends — omit only if the peer supports broadcast, which most sandboxed Docker networks don't. */
  ip?: string;
  onTick: (tick: MavlinkTelemetryTick) => void;
  onError?: (err: Error) => void;
}

export interface MavlinkSourceHandle {
  stop: () => Promise<void>;
}

export async function startMavlinkSource(options: MavlinkSourceOptions): Promise<MavlinkSourceHandle> {
  const port = new MavEsp8266();
  await port.start(options.receivePort, options.sendPort, options.ip);

  // Some MAVLink links (mavlink-router, GCS-side peer filters) stop routing
  // traffic to a peer that never sends its own Heartbeat, even a
  // read-only one — send the standard 1Hz Heartbeat despite this bridge
  // never issuing commands, so the link doesn't silently go quiet.
  const heartbeat = new minimal.Heartbeat();
  heartbeat.type = minimal.MavType.ONBOARD_CONTROLLER;
  heartbeat.autopilot = minimal.MavAutopilot.INVALID;
  heartbeat.baseMode = 0 as minimal.MavModeFlag; // no flags set — a plain telemetry peer, not a flight controller
  heartbeat.customMode = 0;
  heartbeat.systemStatus = minimal.MavState.ACTIVE;
  const heartbeatTimer = setInterval(() => {
    port.send(heartbeat).catch((err: unknown) => {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    });
  }, 1000);

  port.on("data", (packet: MavLinkPacket) => {
    try {
      const clazz = REGISTRY[packet.header.msgid];
      if (!clazz) return;
      const data = packet.protocol.data(packet.payload, clazz);
      if (!(data instanceof common.GlobalPositionInt)) return;

      options.onTick({
        systemId: packet.header.sysid,
        lat: data.lat / 1e7,
        lon: data.lon / 1e7,
        altM: data.alt / 1000,
        headingDeg: data.hdg === HDG_UNKNOWN ? null : data.hdg / 100,
        groundspeedMps: Math.hypot(data.vx, data.vy) / 100,
      });
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return {
    stop: async () => {
      clearInterval(heartbeatTimer);
      await port.close();
    },
  };
}
