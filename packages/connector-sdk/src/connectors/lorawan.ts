// packages/connector-sdk/src/connectors/lorawan.ts — NW-019 reference
// connector #2: a LoRaWAN network-server webhook receiver.
//
// Included specifically because it is the OPPOSITE SHAPE to Modbus. Modbus
// polls outward on a timer; LoRaWAN is pushed inward by a network server
// (TTN, ChirpStack, Helium) that POSTs an uplink as it arrives. If the
// connector interface only fitted pollers it would be a poller framework
// wearing a connector's name, and the second reference implementation is
// where that would show up. It does not: `start()` returns a handle, and
// what it starts happens to be a listener.
//
// LoRaWAN matters commercially for the same vertical as Modbus — remote,
// battery-powered, low-bandwidth sensing over kilometres with no mains
// power, which is the actual shape of perimeter and remote-site monitoring.
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import type { Connector, ConnectorContext, ConnectorHandle, EventSpec } from "../types.js";

export const LorawanUplinkEvent = z.object({
  event_id: z.string().uuid(),
  sensor_id: z.string().min(1),
  /** The end device, as the network server names it. */
  device_id: z.string().min(1),
  /** LoRaWAN application port — the device's own payload discriminator. */
  f_port: z.number().int().min(0).max(255).optional(),
  f_cnt: z.number().int().nonnegative().optional(),
  /** Decoded payload, or the raw base64 when no decoder applies. */
  payload: z.record(z.unknown()),
  rssi: z.number().optional(),
  snr: z.number().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  sensor_ts: z.string().datetime({ offset: true }),
  kafka_ts: z.string().datetime({ offset: true }),
});
export type LorawanUplinkEvent = z.infer<typeof LorawanUplinkEvent>;

export const LORAWAN_EVENT: EventSpec<LorawanUplinkEvent> = {
  domain: "lorawan",
  action: "uplink",
  schema: LorawanUplinkEvent,
};

/**
 * The subset of a network server's uplink body this connector reads.
 *
 * Modelled on The Things Stack v3, which ChirpStack and most others are
 * close enough to that one shape plus `passthrough` covers the field. It
 * is deliberately LOOSE — `.passthrough()`, almost everything optional —
 * because a network server adding a field must not start rejecting every
 * uplink from a device that was working yesterday.
 */
export const uplinkBodySchema = z
  .object({
    end_device_ids: z
      .object({ device_id: z.string().optional(), dev_eui: z.string().optional() })
      .passthrough()
      .optional(),
    uplink_message: z
      .object({
        f_port: z.number().optional(),
        f_cnt: z.number().optional(),
        frm_payload: z.string().optional(),
        decoded_payload: z.record(z.unknown()).optional(),
        received_at: z.string().optional(),
        rx_metadata: z
          .array(
            z
              .object({
                rssi: z.number().optional(),
                snr: z.number().optional(),
                location: z.object({ latitude: z.number().optional(), longitude: z.number().optional() }).passthrough().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    received_at: z.string().optional(),
  })
  .passthrough();

export class LorawanPayloadError extends Error {}

export interface MappedUplink {
  device_id: string;
  f_port?: number;
  f_cnt?: number;
  payload: Record<string, unknown>;
  rssi?: number;
  snr?: number;
  lat?: number;
  lon?: number;
  sensor_ts?: string;
}

/**
 * Maps a network-server body to the connector's event fields.
 *
 * Two decisions worth stating:
 *   - When the network server already decoded the payload, that is used.
 *     Otherwise the raw base64 is passed through under `frm_payload`
 *     rather than dropped — an undecodable payload is still evidence the
 *     device is alive, and discarding it makes a dead decoder look like a
 *     dead sensor.
 *   - `received_at` from the network server is preferred over local time.
 *     The gateway heard it; we are several hops later, and on a
 *     store-and-forward backhaul that gap can be minutes.
 */
export function mapUplink(body: unknown): MappedUplink {
  const parsed = uplinkBodySchema.safeParse(body);
  if (!parsed.success) throw new LorawanPayloadError(`unrecognised uplink body: ${parsed.error.message}`);
  const b = parsed.data;

  const deviceId = b.end_device_ids?.device_id ?? b.end_device_ids?.dev_eui;
  if (!deviceId) throw new LorawanPayloadError("uplink has neither device_id nor dev_eui");

  const up = b.uplink_message ?? {};
  const best = (up.rx_metadata ?? [])
    .slice()
    // Strongest gateway wins: several may hear the same uplink, and their
    // RSSI/SNR differ by tens of dB. Taking the first is taking a random one.
    .sort((x, y) => (y.rssi ?? -Infinity) - (x.rssi ?? -Infinity))[0];

  const payload: Record<string, unknown> =
    up.decoded_payload ?? (up.frm_payload === undefined ? {} : { frm_payload: up.frm_payload });

  return {
    device_id: deviceId,
    f_port: up.f_port,
    f_cnt: up.f_cnt,
    payload,
    rssi: best?.rssi,
    snr: best?.snr,
    lat: best?.location?.latitude,
    lon: best?.location?.longitude,
    sensor_ts: up.received_at ?? b.received_at,
  };
}

export interface LorawanConnectorOptions {
  port: number;
  host?: string;
  path?: string;
  /**
   * Shared secret the network server sends. Compared on every request.
   *
   * Required, with no "unauthenticated if unset" escape: this endpoint
   * injects sensor readings into the fusion pipeline, so an open one lets
   * anybody on the network invent contacts. A connector that is insecure
   * by default is one that ships insecure.
   */
  sharedSecret: string;
  headerName?: string;
  maxBodyBytes?: number;
}

export function createLorawanConnector(options: LorawanConnectorOptions): Connector {
  const path = options.path ?? "/lorawan/uplink";
  const headerName = (options.headerName ?? "x-vektor-secret").toLowerCase();
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (!options.sharedSecret) throw new Error("createLorawanConnector requires a sharedSecret");

  return {
    name: "lorawan-webhook",
    async start(ctx: ConnectorContext): Promise<ConnectorHandle> {
      const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== path) {
            res.writeHead(404).end();
            return;
          }
          if (req.headers[headerName] !== options.sharedSecret) {
            res.writeHead(401).end();
            return;
          }

          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            size += (chunk as Buffer).length;
            // An unbounded body on an unauthenticated-until-header-checked
            // endpoint is a memory exhaustion vector.
            if (size > maxBodyBytes) {
              res.writeHead(413).end();
              req.destroy();
              return;
            }
            chunks.push(chunk as Buffer);
          }

          try {
            const mapped = mapUplink(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            await ctx.publish(LORAWAN_EVENT, mapped as unknown as LorawanUplinkEvent);
            // 204 after publication, not before. A network server that
            // retries on non-2xx is the only redelivery mechanism there
            // is; acking first would turn a transient failure into a lost
            // uplink that nothing can recover.
            res.writeHead(204).end();
          } catch (err) {
            ctx.logger.warn({ connector: "lorawan-webhook", err }, "uplink rejected");
            res.writeHead(400).end();
          }
        })();
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host ?? "0.0.0.0", resolve);
      });
      ctx.logger.info({ connector: "lorawan-webhook", port: options.port, path }, "listening for uplinks");

      return {
        stop: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      };
    },
  };
}
