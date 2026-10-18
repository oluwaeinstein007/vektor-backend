// NW-019. The protocol code is exercised against real sockets and a real
// HTTP server — a Modbus test that mocks the framing proves only that the
// mock agrees with itself, and framing is precisely where this kind of
// code goes wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createConnectorRuntime, ConnectorEventError } from "../src/runtime.js";
import { nextDelayMs, runWithReconnect } from "../src/reconnect.js";
import {
  createModbusConnector,
  encodeReadHoldingRequest,
  decodeReadHoldingResponse,
  decodeRegister,
  registerWordCount,
  ModbusProtocolError,
  MODBUS_EVENT,
} from "../src/connectors/modbus.js";
import { createLorawanConnector, mapUplink, LorawanPayloadError } from "../src/connectors/lorawan.js";
import { parseProbeMatch, parseProfileTokens, parseStreamUri, buildProbeMessage } from "../src/connectors/onvif.js";
import type { Connector } from "../src/types.js";

/** Captures what would have gone to Kafka. */
function recordingProducer() {
  const sent: { topic: string; value: Record<string, unknown> }[] = [];
  let failNext = false;
  return {
    sent,
    failOnce() {
      failNext = true;
    },
    producer: {
      send: async (payload: { topic: string; messages: { value: string }[] }) => {
        if (failNext) {
          failNext = false;
          throw new Error("broker unavailable");
        }
        for (const m of payload.messages) sent.push({ topic: payload.topic, value: JSON.parse(m.value) });
        return [];
      },
    } as never,
  };
}

// ---------------------------------------------------------------- runtime

test("the runtime stamps the envelope, routes the topic, and counts the publish", async () => {
  const rec = recordingProducer();
  const runtime = createConnectorRuntime({ producer: rec.producer, env: "dev" });

  let published!: () => void;
  const done = new Promise<void>((r) => (published = r));
  const connector: Connector = {
    name: "test",
    async start(ctx) {
      await ctx.publish(MODBUS_EVENT, { unit_id: 1, registers: { level: 42 } } as never);
      published();
      return { stop() {} };
    },
  };

  const running = await runtime.run(connector, { sensorId: "scada-1" });
  await done;

  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0]!.topic, "dev.vektor.modbus.telemetry", "topic comes from the spec, never the connector");
  const event = rec.sent[0]!.value;
  assert.match(String(event.event_id), /^[0-9a-f-]{36}$/, "event_id is filled in");
  assert.equal(event.sensor_id, "scada-1");
  assert.ok(event.sensor_ts, "sensor_ts defaulted to now");
  assert.ok(event.kafka_ts, "kafka_ts is always stamped");
  assert.equal(running.stats.published, 1);
  assert.equal(running.stats.rejected, 0);
  await running.stop();
});

test("a connector-supplied sensor_ts is preserved, never overwritten with receipt time", async () => {
  const rec = recordingProducer();
  const runtime = createConnectorRuntime({ producer: rec.producer, env: "dev" });
  // Recent enough to pass the clock check, distinct enough to detect.
  const deviceTime = new Date(Date.now() - 1500).toISOString();

  const connector: Connector = {
    name: "test",
    async start(ctx) {
      await ctx.publish(MODBUS_EVENT, { unit_id: 1, registers: {}, sensor_ts: deviceTime } as never);
      return { stop() {} };
    },
  };
  const running = await runtime.run(connector, { sensorId: "scada-1" });
  assert.equal(rec.sent[0]!.value.sensor_ts, deviceTime, "a device's own clock is the honest timestamp");
  assert.notEqual(rec.sent[0]!.value.kafka_ts, deviceTime, "but kafka_ts is ours");
  await running.stop();
});

test("a malformed event is REJECTED and thrown; a broker failure is counted and swallowed", async () => {
  const rec = recordingProducer();
  const runtime = createConnectorRuntime({ producer: rec.producer, env: "dev" });

  let rejectedErr: unknown;
  let brokerThrew = false;
  const connector: Connector = {
    name: "test",
    async start(ctx) {
      // registers must be numbers — this is the connector's own bug.
      await ctx.publish(MODBUS_EVENT, { unit_id: 1, registers: { bad: "nope" } } as never).catch((e) => {
        rejectedErr = e;
      });
      rec.failOnce();
      try {
        await ctx.publish(MODBUS_EVENT, { unit_id: 1, registers: { ok: 1 } } as never);
      } catch {
        brokerThrew = true;
      }
      return { stop() {} };
    },
  };
  const running = await runtime.run(connector, { sensorId: "scada-1" });

  assert.ok(rejectedErr instanceof ConnectorEventError, "the connector's own bug is surfaced to it");
  assert.equal(
    brokerThrew,
    false,
    "a broker blip must NOT tear down a working feed — it is counted, not thrown",
  );
  assert.equal(running.stats.rejected, 1);
  assert.equal(running.stats.failed, 1);
  assert.equal(running.stats.published, 0);
  await running.stop();
});

test("rejected and failed are counted separately, because they mean opposite things", async () => {
  // A rejected event is a permanent code bug; a failed one is usually
  // transient infrastructure. One combined counter hides a permanent
  // defect inside what looks like noise.
  const rec = recordingProducer();
  const runtime = createConnectorRuntime({ producer: rec.producer, env: "dev" });
  const connector: Connector = { name: "t", start: () => ({ stop() {} }) };
  const running = await runtime.run(connector, { sensorId: "s" });
  const health = runtime.health();
  assert.equal(health.length, 1);
  assert.ok("rejected" in health[0]! && "failed" in health[0]!);
  await running.stop();
});

// --------------------------------------------------------------- backoff

test("backoff doubles, is capped, and is jittered symmetrically", () => {
  const noJitter = { jitter: 0, initialMs: 1000, maxMs: 10_000 };
  assert.equal(nextDelayMs(1, noJitter), 1000);
  assert.equal(nextDelayMs(2, noJitter), 2000);
  assert.equal(nextDelayMs(3, noJitter), 4000);
  assert.equal(nextDelayMs(10, noJitter), 10_000, "capped");

  // Jitter is symmetric: random()=0.5 must land exactly on the base delay,
  // so jitter does not systematically slow every reconnection down.
  assert.equal(nextDelayMs(2, { jitter: 0.5, initialMs: 1000 }, () => 0.5), 2000);
  assert.equal(nextDelayMs(2, { jitter: 0.5, initialMs: 1000 }, () => 0), 1000);
  assert.equal(nextDelayMs(2, { jitter: 0.5, initialMs: 1000 }, () => 1), 3000);
});

test("runWithReconnect retries a failing connect, then stops cleanly", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const reconnects: number[] = [];

  const session = await runWithReconnect({
    signal: controller.signal,
    sleep: async () => {},
    onReconnect: (attempt) => reconnects.push(attempt),
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("refused");
      return { closed: new Promise<void>(() => {}), stop() {} };
    },
  });

  // Give the loop a few turns to get through the two failures.
  for (let i = 0; i < 20 && attempts < 3; i++) await new Promise((r) => setImmediate(r));
  assert.equal(attempts, 3, "kept retrying until the connect succeeded");
  assert.deepEqual(reconnects, [1, 2]);
  controller.abort();
  await session.stop();
});

test("runWithReconnect gives up after maxAttempts rather than looping forever", async () => {
  const controller = new AbortController();
  let gaveUpAfter = 0;
  const session = await runWithReconnect({
    signal: controller.signal,
    sleep: async () => {},
    maxAttempts: 3,
    connect: async () => {
      throw new Error("always fails");
    },
    onGiveUp: (attempts) => (gaveUpAfter = attempts),
  });
  for (let i = 0; i < 50 && gaveUpAfter === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(gaveUpAfter, 3);
  await session.stop();
});

// ---------------------------------------------------------------- modbus

test("modbus request framing matches the MBAP header the spec defines", () => {
  const frame = encodeReadHoldingRequest(0x1234, 7, 0x0010, 2);
  assert.equal(frame.length, 12);
  assert.equal(frame.readUInt16BE(0), 0x1234, "transaction id");
  assert.equal(frame.readUInt16BE(2), 0, "protocol id is always 0 for Modbus/TCP");
  assert.equal(frame.readUInt16BE(4), 6, "length counts everything after this field");
  assert.equal(frame.readUInt8(6), 7, "unit id");
  assert.equal(frame.readUInt8(7), 0x03, "function 3");
  assert.equal(frame.readUInt16BE(8), 0x0010);
  assert.equal(frame.readUInt16BE(10), 2);
});

test("modbus decodes a response, and surfaces an exception reply rather than retrying it blindly", () => {
  const ok = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x02, 0x04, 0xd2]);
  assert.deepEqual([...decodeReadHoldingResponse(ok, 1)], [0x04, 0xd2]);

  // Function code with the high bit set = the device answered with an
  // error. Exception 2 is "illegal data address" and will never succeed.
  const exception = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x01, 0x83, 0x02]);
  assert.throws(() => decodeReadHoldingResponse(exception, 1), /modbus exception 2/);

  // A mismatched transaction id means responses have been interleaved.
  assert.throws(() => decodeReadHoldingResponse(ok, 99), ModbusProtocolError);
  assert.throws(() => decodeReadHoldingResponse(Buffer.alloc(4), 1), /short frame/);
});

test("modbus register decoding handles widths, sign, word order and scaling", () => {
  assert.equal(registerWordCount("uint16"), 1);
  assert.equal(registerWordCount("float32"), 2);

  assert.equal(decodeRegister(Buffer.from([0x04, 0xd2]), { name: "a", address: 0 }), 1234);
  assert.equal(decodeRegister(Buffer.from([0xff, 0xff]), { name: "a", address: 0, type: "int16" }), -1);
  assert.equal(
    decodeRegister(Buffer.from([0x00, 0x01, 0x00, 0x00]), { name: "a", address: 0, type: "uint32" }),
    65536,
  );
  // Devices that use the other word order are common enough that getting
  // this wrong reads as "the value is 65536x too large".
  assert.equal(
    decodeRegister(Buffer.from([0x00, 0x00, 0x00, 0x01]), { name: "a", address: 0, type: "uint32", swapWords: true }),
    65536,
  );
  assert.equal(decodeRegister(Buffer.from([0x04, 0xd2]), { name: "a", address: 0, scale: 0.1 }), 123.4);
});

test("the modbus connector polls a REAL tcp server and publishes decoded registers", async (t) => {
  // A minimal Modbus/TCP slave: echoes the transaction id and answers
  // function 3 with a fixed value. Real framing over a real socket.
  const server: Server = createServer((socket) => {
    socket.on("data", (req) => {
      const txId = req.readUInt16BE(0);
      const unitId = req.readUInt8(6);
      const quantity = req.readUInt16BE(10);
      const byteCount = quantity * 2;
      const res = Buffer.alloc(9 + byteCount);
      res.writeUInt16BE(txId, 0);
      res.writeUInt16BE(0, 2);
      res.writeUInt16BE(3 + byteCount, 4);
      res.writeUInt8(unitId, 6);
      res.writeUInt8(0x03, 7);
      res.writeUInt8(byteCount, 8);
      res.writeUInt16BE(1234, 9);
      socket.write(res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  t.after(() => new Promise<void>((r) => server.close(() => r())));

  const rec = recordingProducer();
  const runtime = createConnectorRuntime({ producer: rec.producer, env: "dev" });
  const connector = createModbusConnector({
    host: "127.0.0.1",
    port,
    unitId: 3,
    pollIntervalMs: 50,
    registers: [{ name: "tank_level_pct", address: 0x10, scale: 0.1 }],
  });

  const running = await runtime.run(connector, { sensorId: "plc-1" });
  for (let i = 0; i < 100 && rec.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await running.stop();

  assert.ok(rec.sent.length >= 1, "polled and published at least once");
  const event = rec.sent[0]!.value;
  assert.equal(rec.sent[0]!.topic, "dev.vektor.modbus.telemetry");
  assert.equal(event.unit_id, 3);
  assert.deepEqual(event.registers, { tank_level_pct: 123.4 }, "scaled into engineering units");
  assert.equal(event.sensor_id, "plc-1");
});

// --------------------------------------------------------------- lorawan

test("lorawan maps a Things-Stack uplink, preferring decoded payload and the strongest gateway", () => {
  const mapped = mapUplink({
    end_device_ids: { device_id: "water-level-7" },
    uplink_message: {
      f_port: 2,
      f_cnt: 91,
      decoded_payload: { level_cm: 143 },
      received_at: "2026-10-18T09:00:00.000Z",
      rx_metadata: [
        { rssi: -110, snr: -4 },
        { rssi: -71, snr: 9, location: { latitude: 59.9, longitude: 10.7 } },
      ],
    },
  });
  assert.equal(mapped.device_id, "water-level-7");
  assert.deepEqual(mapped.payload, { level_cm: 143 });
  assert.equal(mapped.rssi, -71, "strongest gateway, not the first one listed");
  assert.equal(mapped.lat, 59.9);
  assert.equal(mapped.sensor_ts, "2026-10-18T09:00:00.000Z", "the gateway's time, not ours");
});

test("lorawan keeps an undecodable payload rather than dropping it, and falls back to dev_eui", () => {
  const mapped = mapUplink({
    end_device_ids: { dev_eui: "70B3D57ED0001234" },
    uplink_message: { frm_payload: "AQIDBA==" },
  });
  assert.equal(mapped.device_id, "70B3D57ED0001234");
  // An undecodable payload is still proof the device is alive; discarding
  // it makes a broken decoder look like a dead sensor.
  assert.deepEqual(mapped.payload, { frm_payload: "AQIDBA==" });
});

test("lorawan refuses a body with no device identity at all", () => {
  assert.throws(() => mapUplink({ uplink_message: {} }), LorawanPayloadError);
  assert.throws(() => mapUplink("not an object"), LorawanPayloadError);
});

test("the lorawan connector serves a REAL http endpoint, authenticates it, and publishes", async (t) => {
  const rec = recordingProducer();
  const runtime = createConnectorRuntime({ producer: rec.producer, env: "dev" });
  const connector = createLorawanConnector({ port: 0, sharedSecret: "s3cret" });

  // port 0 lets the OS choose; re-read it from the running server.
  const running = await runtime.run(connector, { sensorId: "ttn-eu" });
  t.after(() => running.stop());
  // The connector binds before start() resolves, so a probe of the chosen
  // port is possible only via the server itself; use a fixed port instead.
  await running.stop();

  const fixed = createLorawanConnector({ port: 18411, sharedSecret: "s3cret" });
  const running2 = await runtime.run(fixed, { sensorId: "ttn-eu" });
  t.after(() => running2.stop());

  const body = JSON.stringify({
    end_device_ids: { device_id: "gate-sensor-2" },
    uplink_message: { f_port: 1, decoded_payload: { open: 1 }, rx_metadata: [{ rssi: -80 }] },
  });

  const unauth = await fetch("http://127.0.0.1:18411/lorawan/uplink", { method: "POST", body });
  assert.equal(unauth.status, 401, "an open ingest endpoint lets anyone invent contacts");

  const wrongPath = await fetch("http://127.0.0.1:18411/nope", {
    method: "POST",
    body,
    headers: { "x-vektor-secret": "s3cret" },
  });
  assert.equal(wrongPath.status, 404);

  const ok = await fetch("http://127.0.0.1:18411/lorawan/uplink", {
    method: "POST",
    body,
    headers: { "x-vektor-secret": "s3cret" },
  });
  assert.equal(ok.status, 204, "acked only AFTER publication, so a retry can still save it");

  const published = rec.sent.find((m) => m.topic === "dev.vektor.lorawan.uplink");
  assert.ok(published, "uplink reached Kafka");
  assert.equal(published!.value.device_id, "gate-sensor-2");
  assert.equal(published!.value.sensor_id, "ttn-eu");

  const bad = await fetch("http://127.0.0.1:18411/lorawan/uplink", {
    method: "POST",
    body: "{}",
    headers: { "x-vektor-secret": "s3cret" },
  });
  assert.equal(bad.status, 400, "a malformed uplink is rejected, not acked");
});

test("the lorawan connector refuses to be constructed without a shared secret", () => {
  assert.throws(() => createLorawanConnector({ port: 1, sharedSecret: "" }), /sharedSecret/);
});

// ----------------------------------------------------------------- onvif

test("onvif parses a ProbeMatch, picking an http XAddr and stripping the urn prefix", () => {
  const xml = `<e:Envelope><e:Body><d:ProbeMatches><d:ProbeMatch>
    <w:EndpointReference><w:Address>urn:uuid:abcd-1234</w:Address></w:EndpointReference>
    <d:Scopes>onvif://www.onvif.org/name/AcmeCam onvif://www.onvif.org/location/gate</d:Scopes>
    <d:XAddrs>http://192.168.1.50/onvif/device_service</d:XAddrs>
  </d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>`;
  const [device] = parseProbeMatch(xml);
  assert.ok(device);
  assert.equal(device.device_uuid, "abcd-1234");
  assert.equal(device.xaddr, "http://192.168.1.50/onvif/device_service");
  assert.ok(device.scopes.includes("onvif://www.onvif.org/location/gate"));

  assert.deepEqual(parseProbeMatch("<nothing/>"), [], "a non-match yields nothing, not a throw");
});

test("onvif builds a well-formed probe and reads profiles and stream URIs out of SOAP replies", () => {
  const probe = buildProbeMessage("uuid:fixed");
  assert.match(probe, /NetworkVideoTransmitter/);
  assert.match(probe, /uuid:fixed/);

  const profiles = `<s:Body><trt:GetProfilesResponse>
    <trt:Profiles token="Profile_1" fixed="true"/><trt:Profiles token="Profile_2"/>
  </trt:GetProfilesResponse></s:Body>`;
  assert.deepEqual(parseProfileTokens(profiles), ["Profile_1", "Profile_2"]);

  const uri = `<s:Body><trt:GetStreamUriResponse><trt:MediaUri>
    <tt:Uri>rtsp://192.168.1.50:554/Streaming/Channels/101</tt:Uri>
  </trt:MediaUri></trt:GetStreamUriResponse></s:Body>`;
  assert.equal(parseStreamUri(uri), "rtsp://192.168.1.50:554/Streaming/Channels/101");
});
