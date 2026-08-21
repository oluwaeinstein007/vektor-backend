// Real Socket.io server + real socket.io-client connection — this is the
// boundary-validation logic (onValidated), so it's only meaningful proven
// against the actual wire protocol, not a mocked socket object.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as HttpServer } from "node:http";
import { Server as SocketIoServer } from "socket.io";
import { createVektorSocket, onValidated, type VektorSocket } from "../src/lib/socket-client.ts";

let httpServer: HttpServer;
let io: SocketIoServer;
let client: VektorSocket;
let serverSocketId: string | undefined;

before(async () => {
  httpServer = createServer();
  io = new SocketIoServer(httpServer);
  io.on("connection", (socket) => {
    serverSocketId = socket.id;
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound address");

  client = createVektorSocket(`http://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve) => client.on("connect", () => resolve()));
});

after(async () => {
  client.disconnect();
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function emitFromServer(event: string, payload: unknown) {
  if (!serverSocketId) throw new Error("no client connected to the test server yet");
  io.to(serverSocketId).emit(event, payload);
}

test("onValidated passes a schema-conforming payload through to the handler", async () => {
  const received: unknown[] = [];
  const invalid: unknown[] = [];
  const unsubscribe = onValidated(
    client,
    "sensor:status",
    (health) => received.push(health),
    (event, error) => invalid.push({ event, error }),
  );

  emitFromServer("sensor:status", {
    sensor_id: "cam-1",
    status: "ONLINE",
    latency_ms: 42,
    drop_rate: 0.001,
    last_heartbeat: new Date().toISOString(),
  });

  const deadline = Date.now() + 5_000;
  while (received.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(received.length, 1);
  assert.equal(invalid.length, 0);
  assert.equal((received[0] as { sensor_id: string }).sensor_id, "cam-1");
  unsubscribe();
});

test("onValidated drops a malformed payload and reports it via onInvalid, never calling the handler", async () => {
  const received: unknown[] = [];
  const invalid: unknown[] = [];
  const unsubscribe = onValidated(
    client,
    "sensor:status",
    (health) => received.push(health),
    (event, error) => invalid.push({ event, error }),
  );

  // Missing required fields (latency_ms, drop_rate, last_heartbeat) and an
  // invalid `status` enum value.
  emitFromServer("sensor:status", { sensor_id: "cam-2", status: "UNKNOWN_STATUS" });

  const deadline = Date.now() + 5_000;
  while (invalid.length < 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(invalid.length, 1);
  assert.equal(received.length, 0, "handler must never see a payload that failed validation");
  unsubscribe();
});

test("unsubscribe stops delivering further events", async () => {
  const received: unknown[] = [];
  const unsubscribe = onValidated(client, "sensor:status", (health) => received.push(health));
  unsubscribe();

  emitFromServer("sensor:status", {
    sensor_id: "cam-3",
    status: "ONLINE",
    latency_ms: 10,
    drop_rate: 0,
    last_heartbeat: new Date().toISOString(),
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(received.length, 0);
});
