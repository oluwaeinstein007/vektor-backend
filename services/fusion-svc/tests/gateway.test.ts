// API-002/REQ-9.2: "Client receives only events within its subscribed AOI."
// Real Socket.io client/server round-trip (socket.io-client against a real
// HTTP server), not a call-the-method-directly unit test — the actual
// `subscribe:area`/entity:* wire contract is what's under test here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { Entity } from "@vektor/shared";
import { FusionGateway } from "../src/socket/gateway.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeEntity(overrides: Partial<Entity["position"]> = {}): Entity {
  return {
    entity_id: randomUUID(),
    classification: "GroundVehicle.Tracked",
    confidence: 0.9,
    status: "ACTIVE",
    affiliation: "UNKNOWN",
    source_sensors: ["sensor-1"],
    position: { lat: 50, lon: 10, alt_m: 0, mgrs: "", accuracy_m: 5, ...overrides },
    kinematics: { speed_kmh: 0, heading_deg: 0, trajectory: [] },
    metadata: { tags: [], analyst_notes: "", no_strike: false },
    first_detected: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  };
}

async function startServer(): Promise<{ httpServer: HttpServer; gateway: FusionGateway; port: number }> {
  const httpServer = createServer();
  const gateway = new FusionGateway(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { httpServer, gateway, port };
}

function connect(port: number): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", reject);
  });
}

test("a client with no subscription receives every entity event (pre-API-002 broadcast behavior preserved)", async (t) => {
  const { httpServer, gateway, port } = await startServer();
  const client = await connect(port);
  t.after(() => {
    client.disconnect();
    return gateway.close();
  });

  const received: string[] = [];
  client.on("entity:new", (e: Entity) => received.push(e.entity_id));

  const inside = makeEntity({ lat: 50, lon: 10 });
  const farAway = makeEntity({ lat: -30, lon: 150 });
  gateway.emitEntityNew(inside);
  gateway.emitEntityNew(farAway);

  await sleep(300);
  assert.deepEqual(received.sort(), [inside.entity_id, farAway.entity_id].sort());
});

test("subscribe:area scopes entity:new/updated/lost to the bounding box, excluding entities outside it", async (t) => {
  const { httpServer, gateway, port } = await startServer();
  const client = await connect(port);
  t.after(() => {
    client.disconnect();
    return gateway.close();
  });

  client.emit("subscribe:area", { min_lat: 49, min_lon: 9, max_lat: 51, max_lon: 11 });
  await sleep(200); // let the subscription land server-side before emitting

  const received: string[] = [];
  client.on("entity:new", (e: Entity) => received.push(e.entity_id));

  const inside = makeEntity({ lat: 50, lon: 10 });
  const outside = makeEntity({ lat: -30, lon: 150 });
  gateway.emitEntityNew(inside);
  gateway.emitEntityNew(outside);

  await sleep(300);
  assert.deepEqual(received, [inside.entity_id]);
});

test("unsubscribe reverts to receiving every entity event again", async (t) => {
  const { httpServer, gateway, port } = await startServer();
  const client = await connect(port);
  t.after(() => {
    client.disconnect();
    return gateway.close();
  });

  client.emit("subscribe:area", { min_lat: 49, min_lon: 9, max_lat: 51, max_lon: 11 });
  await sleep(200);
  client.emit("unsubscribe");
  await sleep(200);

  const received: string[] = [];
  client.on("entity:new", (e: Entity) => received.push(e.entity_id));

  const farAway = makeEntity({ lat: -30, lon: 150 });
  gateway.emitEntityNew(farAway);

  await sleep(300);
  assert.deepEqual(received, [farAway.entity_id]);
});

test("two clients with different AOIs each see only their own scoped events", async (t) => {
  const { httpServer, gateway, port } = await startServer();
  const clientA = await connect(port);
  const clientB = await connect(port);
  t.after(() => {
    clientA.disconnect();
    clientB.disconnect();
    return gateway.close();
  });

  clientA.emit("subscribe:area", { min_lat: 49, min_lon: 9, max_lat: 51, max_lon: 11 }); // Europe-ish
  clientB.emit("subscribe:area", { min_lat: -35, min_lon: 145, max_lat: -25, max_lon: 155 }); // Australia-ish
  await sleep(200);

  const receivedA: string[] = [];
  const receivedB: string[] = [];
  clientA.on("entity:new", (e: Entity) => receivedA.push(e.entity_id));
  clientB.on("entity:new", (e: Entity) => receivedB.push(e.entity_id));

  const europeEntity = makeEntity({ lat: 50, lon: 10 });
  const australiaEntity = makeEntity({ lat: -30, lon: 150 });
  gateway.emitEntityNew(europeEntity);
  gateway.emitEntityNew(australiaEntity);

  await sleep(300);
  assert.deepEqual(receivedA, [europeEntity.entity_id]);
  assert.deepEqual(receivedB, [australiaEntity.entity_id]);
});

test("sensor:status is never AOI-scoped — every client receives it regardless of subscription", async (t) => {
  const { httpServer, gateway, port } = await startServer();
  const client = await connect(port);
  t.after(() => {
    client.disconnect();
    return gateway.close();
  });

  client.emit("subscribe:area", { min_lat: 49, min_lon: 9, max_lat: 51, max_lon: 11 });
  await sleep(200);

  let received = false;
  client.on("sensor:status", () => {
    received = true;
  });

  gateway.emitSensorStatus({
    sensor_id: "sensor-far-away",
    status: "ONLINE",
    latency_ms: 10,
    drop_rate: 0,
    last_heartbeat: new Date().toISOString(),
  });

  await sleep(300);
  assert.equal(received, true);
});

test("a malformed subscribe:area payload is ignored, not a crash — existing subscription state is unchanged", async (t) => {
  const { httpServer, gateway, port } = await startServer();
  const client = await connect(port);
  t.after(() => {
    client.disconnect();
    return gateway.close();
  });

  client.emit("subscribe:area", { not: "a bounding box" });
  await sleep(200);

  const received: string[] = [];
  client.on("entity:new", (e: Entity) => received.push(e.entity_id));

  const entity = makeEntity({ lat: -30, lon: 150 });
  gateway.emitEntityNew(entity);

  await sleep(300);
  // Malformed subscribe never took effect, so this client stayed
  // unsubscribed (receives everything) rather than the gateway crashing or
  // silently dropping the connection.
  assert.deepEqual(received, [entity.entity_id]);
});
