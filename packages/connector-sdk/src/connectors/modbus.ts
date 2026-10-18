// packages/connector-sdk/src/connectors/modbus.ts — NW-019 reference
// connector #1: a generic Modbus/TCP SCADA tap.
//
// Chosen first because 18-use-cases.md ranks critical infrastructure and
// perimeter monitoring the strongest COMMERCIAL fit, and Modbus is what the
// equipment in that vertical actually speaks — pumps, breakers, RTUs, PLCs,
// building management. "Does it support my sensor?" in vertical B usually
// means "does it read Modbus registers?".
//
// Real protocol, not a sketch: MBAP header framing and function code 3
// (Read Holding Registers) are implemented here and exercised against a
// real TCP server in the tests. No external Modbus library — the read path
// is about forty lines, and a dependency would be a larger surface than the
// code it replaces.
//
// Deliberately read-only. Modbus has no authentication of any kind, and a
// connector that can WRITE coils is a connector that can open a breaker.
// Ingest is a read concern; if control ever becomes a product feature it
// should be a separate, explicitly-gated component, not a flag on this one.
import { createConnection, type Socket } from "node:net";
import { z } from "zod";
import type { Connector, ConnectorContext, ConnectorHandle, EventSpec } from "../types.js";
import { runWithReconnect, type BackoffOptions } from "../reconnect.js";

export const ModbusTelemetryEvent = z.object({
  event_id: z.string().uuid(),
  sensor_id: z.string().min(1),
  unit_id: z.number().int().min(0).max(255),
  /** Register address → decoded value, under the operator's own names. */
  registers: z.record(z.number()),
  sensor_ts: z.string().datetime({ offset: true }),
  kafka_ts: z.string().datetime({ offset: true }),
});
export type ModbusTelemetryEvent = z.infer<typeof ModbusTelemetryEvent>;

export const MODBUS_EVENT: EventSpec<ModbusTelemetryEvent> = {
  domain: "modbus",
  action: "telemetry",
  schema: ModbusTelemetryEvent,
};

/** One named quantity to read out of the device's holding registers. */
export interface ModbusRegisterSpec {
  name: string;
  address: number;
  /**
   * uint16 is one register; int32/uint32/float32 are two, big-endian,
   * which is what the Modbus spec says and what most devices do. Devices
   * that use the other word order exist; `swapWords` handles them, because
   * discovering a byte-order problem as "the pressure reading is 65536
   * times too big" is a bad afternoon.
   */
  type?: "uint16" | "int16" | "uint32" | "int32" | "float32";
  swapWords?: boolean;
  /** Applied after decoding: raw counts → engineering units. */
  scale?: number;
}

export interface ModbusConnectorOptions {
  host: string;
  port?: number;
  unitId?: number;
  registers: ModbusRegisterSpec[];
  pollIntervalMs?: number;
  /** Per-request timeout. Modbus devices can simply not answer. */
  requestTimeoutMs?: number;
  backoff?: BackoffOptions;
}

const FUNCTION_READ_HOLDING = 0x03;

export function registerWordCount(type: ModbusRegisterSpec["type"] = "uint16"): number {
  return type === "uint32" || type === "int32" || type === "float32" ? 2 : 1;
}

/** MBAP header + PDU for function 3. */
export function encodeReadHoldingRequest(txId: number, unitId: number, address: number, quantity: number): Buffer {
  const frame = Buffer.alloc(12);
  frame.writeUInt16BE(txId & 0xffff, 0); // transaction id
  frame.writeUInt16BE(0, 2); // protocol id, always 0 for Modbus/TCP
  frame.writeUInt16BE(6, 4); // length of everything after this field
  frame.writeUInt8(unitId, 6);
  frame.writeUInt8(FUNCTION_READ_HOLDING, 7);
  frame.writeUInt16BE(address, 8);
  frame.writeUInt16BE(quantity, 10);
  return frame;
}

export class ModbusProtocolError extends Error {}

/**
 * Parses a response PDU's data section.
 *
 * Modbus signals errors by setting the high bit of the function code and
 * returning a one-byte exception code. That is NOT a transport error — the
 * device answered — so it must be surfaced rather than retried blindly:
 * exception 2 (illegal data address) means the register map is wrong and
 * will never succeed, and retrying it forever is how a misconfigured
 * connector hammers a PLC.
 */
export function decodeReadHoldingResponse(frame: Buffer, expectedTxId: number): Buffer {
  if (frame.length < 9) throw new ModbusProtocolError(`short frame: ${frame.length} bytes`);
  const txId = frame.readUInt16BE(0);
  if (txId !== expectedTxId) throw new ModbusProtocolError(`transaction id ${txId} != expected ${expectedTxId}`);
  const fn = frame.readUInt8(7);
  if (fn === (FUNCTION_READ_HOLDING | 0x80)) {
    throw new ModbusProtocolError(`modbus exception ${frame.readUInt8(8)}`);
  }
  if (fn !== FUNCTION_READ_HOLDING) throw new ModbusProtocolError(`unexpected function code 0x${fn.toString(16)}`);
  const byteCount = frame.readUInt8(8);
  const data = frame.subarray(9, 9 + byteCount);
  if (data.length !== byteCount) throw new ModbusProtocolError(`declared ${byteCount} bytes, got ${data.length}`);
  return data;
}

export function decodeRegister(data: Buffer, spec: ModbusRegisterSpec): number {
  const type = spec.type ?? "uint16";
  let raw: number;
  if (type === "uint16") raw = data.readUInt16BE(0);
  else if (type === "int16") raw = data.readInt16BE(0);
  else {
    const hi = data.readUInt16BE(0);
    const lo = data.readUInt16BE(2);
    const ordered = Buffer.alloc(4);
    ordered.writeUInt16BE(spec.swapWords ? lo : hi, 0);
    ordered.writeUInt16BE(spec.swapWords ? hi : lo, 2);
    if (type === "uint32") raw = ordered.readUInt32BE(0);
    else if (type === "int32") raw = ordered.readInt32BE(0);
    else raw = ordered.readFloatBE(0);
  }
  return spec.scale === undefined ? raw : raw * spec.scale;
}

/** Reads one register block from a connected socket. */
export function readRegisters(
  socket: Socket,
  txId: number,
  unitId: number,
  address: number,
  quantity: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new ModbusProtocolError("modbus request timed out")), timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    function finish(err?: Error, value?: Buffer): void {
      cleanup();
      if (err) reject(err);
      else resolve(value!);
    }
    function onError(err: Error): void {
      finish(err);
    }
    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      // TCP gives no message boundaries. The MBAP length field at offset 4
      // is what says where this response ends — without honouring it, a
      // coalesced pair of responses parses as one corrupt frame.
      if (buffer.length < 6) return;
      const declared = buffer.readUInt16BE(4);
      const total = 6 + declared;
      if (buffer.length < total) return;
      try {
        finish(undefined, decodeReadHoldingResponse(buffer.subarray(0, total), txId));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    }

    socket.on("data", onData);
    socket.on("error", onError);
    socket.write(encodeReadHoldingRequest(txId, unitId, address, quantity));
  });
}

export function createModbusConnector(options: ModbusConnectorOptions): Connector {
  const port = options.port ?? 502;
  const unitId = options.unitId ?? 1;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 2_000;

  return {
    name: "modbus-tcp",
    async start(ctx: ConnectorContext): Promise<ConnectorHandle> {
      const session = await runWithReconnect({
        signal: ctx.signal,
        ...options.backoff,
        onReconnect: (attempt, delayMs, err) =>
          ctx.logger.warn({ connector: "modbus-tcp", attempt, delayMs, err }, "modbus reconnecting"),
        connect: async () => {
          const socket = createConnection({ host: options.host, port });
          await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          });

          let txId = 0;
          let stopped = false;
          let resolveClosed: () => void;
          let rejectClosed: (err: Error) => void;
          const closed = new Promise<void>((res, rej) => {
            resolveClosed = res;
            rejectClosed = rej;
          });
          socket.once("close", () => (stopped ? resolveClosed() : rejectClosed(new Error("socket closed"))));
          socket.once("error", (err) => rejectClosed(err));

          const poll = async (): Promise<void> => {
            if (stopped || ctx.signal.aborted) return;
            try {
              const registers: Record<string, number> = {};
              for (const spec of options.registers) {
                txId = (txId + 1) & 0xffff;
                const words = registerWordCount(spec.type);
                const data = await readRegisters(socket, txId, unitId, spec.address, words, requestTimeoutMs);
                registers[spec.name] = decodeRegister(data, spec);
              }
              await ctx.publish(MODBUS_EVENT, {
                unit_id: unitId,
                registers,
                // A Modbus device has no clock and no timestamp in the
                // protocol. Poll time is the honest answer; the SDK fills
                // it because this connector leaves sensor_ts unset.
              } as unknown as ModbusTelemetryEvent);
            } catch (err) {
              // A read failure is per-poll, not fatal: a PLC that misses
              // one request is normal. A socket-level failure surfaces
              // through `closed` instead and triggers a reconnect.
              ctx.logger.warn({ connector: "modbus-tcp", err }, "modbus poll failed");
            }
          };

          void poll();
          const timer = setInterval(() => void poll(), pollIntervalMs);
          timer.unref?.();

          return {
            closed,
            stop: () => {
              stopped = true;
              clearInterval(timer);
              socket.destroy();
            },
          };
        },
      });

      return { stop: () => session.stop() };
    },
  };
}
