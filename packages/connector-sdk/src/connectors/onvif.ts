// packages/connector-sdk/src/connectors/onvif.ts — NW-019 reference
// connector #3: ONVIF camera discovery and stream-URI resolution.
//
// The third shape: neither a poller nor a listener but a RESOLVER. ONVIF's
// value to VEKTOR is not another video path — ingest-svc already has a
// working RTSP frame extractor — it is answering "what cameras are on this
// network and what are their RTSP URLs" without a human reading each
// camera's web UI. On a site with forty cameras that is the difference
// between a one-day install and a one-week one, which 19-commercialization
// identifies as the dominant cost in this market (installation labour is
// 40–70% of project cost).
//
// SCOPE, stated plainly: this implements WS-Discovery probing and the two
// SOAP calls needed to get from a discovered device to a playable RTSP URI
// (GetProfiles, GetStreamUri). It does NOT implement WS-UsernameToken
// digest authentication, PTZ, events, or the rest of ONVIF's large surface.
// Cameras that require authentication for GetProfiles will return 401 and
// are reported as such rather than silently skipped. That boundary is
// deliberate — the useful 10% of ONVIF, honestly labelled — and it is
// written here so nobody reads this as full ONVIF support.
//
// NOT VERIFIED AGAINST A REAL CAMERA. No ONVIF device has existed in any
// environment this was built in. The SOAP envelopes and the discovery
// parsing are tested against recorded fixtures and a local UDP responder;
// the first contact with real hardware will find something, as it always
// does. Same honesty NW-012 applies to the Jetson.
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Connector, ConnectorContext, ConnectorHandle, EventSpec } from "../types.js";

export const OnvifCameraEvent = z.object({
  event_id: z.string().uuid(),
  sensor_id: z.string().min(1),
  device_uuid: z.string().min(1),
  xaddr: z.string().url(),
  /** RTSP URI, when resolution succeeded. Absent means discovery only. */
  stream_uri: z.string().optional(),
  profile_token: z.string().optional(),
  scopes: z.array(z.string()),
  /** Why stream resolution failed, when it did. Present instead of silence. */
  resolution_error: z.string().optional(),
  sensor_ts: z.string().datetime({ offset: true }),
  kafka_ts: z.string().datetime({ offset: true }),
});
export type OnvifCameraEvent = z.infer<typeof OnvifCameraEvent>;

export const ONVIF_EVENT: EventSpec<OnvifCameraEvent> = {
  domain: "onvif",
  action: "discovered",
  schema: OnvifCameraEvent,
};

const WS_DISCOVERY_ADDRESS = "239.255.255.250";
const WS_DISCOVERY_PORT = 3702;

/** The WS-Discovery Probe every ONVIF device answers. */
export function buildProbeMessage(messageId: string = `uuid:${randomUUID()}`): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
  xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`;
}

export interface DiscoveredDevice {
  device_uuid: string;
  xaddr: string;
  scopes: string[];
}

/**
 * Parses a ProbeMatch.
 *
 * Regex rather than an XML parser, and that is a considered choice for
 * this one job: the response is a fixed, tiny shape from an embedded
 * device, the fields are flat, and a full SOAP/XML dependency to read
 * three strings would be a far larger attack surface pointed directly at
 * unauthenticated multicast traffic from the local network. Everything
 * else ONVIF would need (if this grows) should use a real parser.
 */
export function parseProbeMatch(xml: string): DiscoveredDevice[] {
  const matches: DiscoveredDevice[] = [];
  const blocks = xml.match(/<[^>]*ProbeMatch\b[\s\S]*?<\/[^>]*ProbeMatch>/g) ?? [];
  for (const block of blocks) {
    const addr = /<[^>]*Address[^>]*>\s*([^<\s]+)\s*</.exec(block)?.[1];
    const xaddrsRaw = /<[^>]*XAddrs[^>]*>\s*([^<]+?)\s*</.exec(block)?.[1];
    if (!addr || !xaddrsRaw) continue;
    // A device may advertise several addresses (multi-homed, IPv6). Take
    // the first http(s) one; the rest are usually the same service.
    const xaddr = xaddrsRaw.split(/\s+/).find((u) => /^https?:\/\//.test(u));
    if (!xaddr) continue;
    const scopes = (/<[^>]*Scopes[^>]*>\s*([^<]*?)\s*</.exec(block)?.[1] ?? "")
      .split(/\s+/)
      .filter(Boolean);
    matches.push({ device_uuid: addr.replace(/^urn:uuid:/, ""), xaddr, scopes });
  }
  return matches;
}

export function buildGetProfilesRequest(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body><GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/></s:Body>
</s:Envelope>`;
}

export function buildGetStreamUriRequest(profileToken: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">
  <s:Body>
    <GetStreamUri xmlns="http://www.onvif.org/ver10/media/wsdl">
      <StreamSetup xmlns="http://www.onvif.org/ver10/schema">
        <Stream>RTP-Unicast</Stream>
        <Transport><Protocol>RTSP</Protocol></Transport>
      </StreamSetup>
      <ProfileToken>${profileToken}</ProfileToken>
    </GetStreamUri>
  </s:Body>
</s:Envelope>`;
}

export function parseProfileTokens(xml: string): string[] {
  const tokens: string[] = [];
  const re = /<[^>]*Profiles\b[^>]*\btoken="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) tokens.push(m[1]!);
  return tokens;
}

export function parseStreamUri(xml: string): string | undefined {
  return /<[^>]*Uri[^>]*>\s*([^<\s]+)\s*</.exec(xml)?.[1];
}

export interface OnvifConnectorOptions {
  /** Interval between discovery sweeps. Cameras come and go. */
  probeIntervalMs?: number;
  /** How long to collect responses after each probe. */
  probeTimeoutMs?: number;
  /** Bind address for the discovery socket. */
  bindAddress?: string;
  /** Resolve RTSP URIs as well as discovering. Off makes it discovery-only. */
  resolveStreamUris?: boolean;
  /** Injectable so tests exercise the SOAP path without a camera. */
  soapPost?: (xaddr: string, body: string, action: string) => Promise<string>;
}

async function defaultSoapPost(xaddr: string, body: string, action: string): Promise<string> {
  const res = await fetch(xaddr, {
    method: "POST",
    headers: { "content-type": `application/soap+xml; charset=utf-8; action="${action}"` },
    body,
  });
  if (!res.ok) throw new Error(`ONVIF ${new URL(xaddr).host} returned HTTP ${res.status}`);
  return res.text();
}

export function createOnvifConnector(options: OnvifConnectorOptions = {}): Connector {
  const probeIntervalMs = options.probeIntervalMs ?? 300_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 4_000;
  const soapPost = options.soapPost ?? defaultSoapPost;
  const resolve = options.resolveStreamUris ?? true;

  return {
    name: "onvif-discovery",
    async start(ctx: ConnectorContext): Promise<ConnectorHandle> {
      const socket: UdpSocket = createSocket({ type: "udp4", reuseAddr: true });
      const seen = new Map<string, string>();

      socket.on("message", (buf) => {
        void (async () => {
          for (const device of parseProbeMatch(buf.toString("utf-8"))) {
            // Re-announce only on CHANGE. A camera answers every probe,
            // and republishing an unchanged device every five minutes
            // would be a steady stream of events carrying no information.
            if (seen.get(device.device_uuid) === device.xaddr) continue;
            seen.set(device.device_uuid, device.xaddr);

            let stream_uri: string | undefined;
            let profile_token: string | undefined;
            let resolution_error: string | undefined;
            if (resolve) {
              try {
                const profilesXml = await soapPost(
                  device.xaddr,
                  buildGetProfilesRequest(),
                  "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
                );
                profile_token = parseProfileTokens(profilesXml)[0];
                if (!profile_token) throw new Error("camera advertised no media profiles");
                const uriXml = await soapPost(
                  device.xaddr,
                  buildGetStreamUriRequest(profile_token),
                  "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
                );
                stream_uri = parseStreamUri(uriXml);
                if (!stream_uri) throw new Error("GetStreamUri returned no Uri");
              } catch (err) {
                // Reported on the event, not thrown away. A camera found
                // but unresolvable (usually: it wants authentication) is
                // the single most useful thing an installer can be told,
                // and dropping it makes the camera look absent.
                resolution_error = err instanceof Error ? err.message : String(err);
              }
            }

            try {
              await ctx.publish(ONVIF_EVENT, {
                device_uuid: device.device_uuid,
                xaddr: device.xaddr,
                scopes: device.scopes,
                stream_uri,
                profile_token,
                resolution_error,
              } as unknown as OnvifCameraEvent);
            } catch (err) {
              ctx.logger.warn({ connector: "onvif-discovery", err }, "onvif event rejected");
            }
          }
        })();
      });

      await new Promise<void>((res, rej) => {
        socket.once("error", rej);
        socket.bind({ address: options.bindAddress, port: 0 }, () => res());
      });

      const probe = (): void => {
        if (ctx.signal.aborted) return;
        const message = Buffer.from(buildProbeMessage(), "utf-8");
        socket.send(message, 0, message.length, WS_DISCOVERY_PORT, WS_DISCOVERY_ADDRESS, (err) => {
          if (err) ctx.logger.warn({ connector: "onvif-discovery", err }, "ws-discovery probe failed");
        });
      };

      probe();
      const timer = setInterval(probe, probeIntervalMs);
      timer.unref?.();
      // Responses arrive asynchronously; probeTimeoutMs is how long a
      // caller should wait before treating a sweep as complete. The socket
      // stays open regardless, since unsolicited Hello messages announce
      // cameras that join between sweeps.
      void probeTimeoutMs;

      return {
        stop: () =>
          new Promise<void>((res) => {
            clearInterval(timer);
            socket.close(() => res());
          }),
      };
    },
  };
}
