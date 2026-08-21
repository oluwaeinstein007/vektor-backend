// Verifies actual HTTP Range semantics — that's the entire correctness
// contract for a PMTiles server (see app.ts's docstring). Uses a small
// synthetic binary file rather than a real .pmtiles archive: the PMTiles
// format itself is opaque to this server, only byte-range serving matters.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let tilesDir: string;
const FILE_CONTENTS = Buffer.from("0123456789ABCDEF"); // 16 bytes, easy to index by hand

before(async () => {
  tilesDir = await mkdtemp(join(tmpdir(), "vektor-tiles-"));
  await writeFile(join(tilesDir, "area.pmtiles"), FILE_CONTENTS);
  app = buildApp({ tilesDir, logger: false });
  await app.ready();
});

after(async () => {
  await app.close();
  await rm(tilesDir, { recursive: true, force: true });
});

test("GET /healthz", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
});

test("full file GET returns 200 with Accept-Ranges: bytes", async () => {
  const res = await app.inject({ method: "GET", url: "/tiles/area.pmtiles" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["accept-ranges"], "bytes");
  assert.equal(res.rawPayload.length, FILE_CONTENTS.length);
});

test("a byte-range request returns 206 with exactly the requested slice", async () => {
  // This is the actual mechanism the PMTiles client relies on to fetch one
  // tile out of a multi-GB archive without downloading the whole thing.
  const res = await app.inject({
    method: "GET",
    url: "/tiles/area.pmtiles",
    headers: { range: "bytes=2-5" },
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["content-range"], "bytes 2-5/16");
  assert.deepEqual(res.rawPayload, FILE_CONTENTS.subarray(2, 6));
});

test("an out-of-bounds range returns 416", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/tiles/area.pmtiles",
    headers: { range: "bytes=1000-2000" },
  });
  assert.equal(res.statusCode, 416);
});

test("a missing archive returns 404, not a crash", async () => {
  const res = await app.inject({ method: "GET", url: "/tiles/does-not-exist.pmtiles" });
  assert.equal(res.statusCode, 404);
});

test("path traversal outside tilesDir is rejected", async () => {
  const res = await app.inject({ method: "GET", url: "/tiles/../../etc/passwd" });
  assert.notEqual(res.statusCode, 200);
});
