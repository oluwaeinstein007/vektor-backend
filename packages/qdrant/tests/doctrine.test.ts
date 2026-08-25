// Real Qdrant (docker) + real BGE-M3 inference (@xenova/transformers
// downloads Xenova/bge-m3's quantized ONNX weights on first use, cached to
// disk after that) — no mocks. This is the one part of ML-008 that's slow
// the first time a machine runs it (the model is ~570MB), same class of
// cost as cv-train-svc's torch install, not a reason to mock it away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createQdrantClient } from "../src/client.js";
import { ensureDoctrineCollection, ingestDoctrineDocument, searchDoctrine } from "../src/doctrine.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:16333";

test("ingestDoctrineDocument embeds and stores chunks; searchDoctrine retrieves the most relevant one", async () => {
  const client = createQdrantClient(QDRANT_URL);
  await ensureDoctrineCollection(client);

  const source = `test-doctrine-${Date.now()}.md`;
  const text =
    "No-Strike Zones.\n\nAny COA option that would place ordnance within a registered " +
    "no-strike zone is prohibited without exception.\n\n" +
    "Asset Tasking.\n\nA recommended Course of Action must only list required assets " +
    "that exist in the current blue-force asset inventory.";

  const chunkCount = await ingestDoctrineDocument(client, source, text);
  assert.ok(chunkCount >= 1); // multi-chunk splitting itself is chunk.test.ts's job; this text is short enough to land in one chunk

  const hits = await searchDoctrine(client, "no-strike zone prohibition", 3);
  assert.ok(hits.length > 0);
  const topHit = hits[0]!;
  assert.ok(topHit.text.toLowerCase().includes("no-strike"));
  assert.ok(topHit.score > 0);
});

test("re-ingesting the same source replaces its old chunks rather than duplicating them", async () => {
  const client = createQdrantClient(QDRANT_URL);
  await ensureDoctrineCollection(client);

  const source = `test-reingest-${Date.now()}.md`;
  await ingestDoctrineDocument(client, source, "Version one paragraph.\n\nSecond paragraph here.");
  const firstCount = await ingestDoctrineDocument(client, source, "Version two, a single short paragraph.");

  assert.equal(firstCount, 1);
  const hits = await searchDoctrine(client, "Version two", 10);
  const fromThisSource = hits.filter((h) => h.source === source);
  assert.equal(fromThisSource.length, 1);
});

test("ensureDoctrineCollection is idempotent", async () => {
  const client = createQdrantClient(QDRANT_URL);
  await ensureDoctrineCollection(client);
  await ensureDoctrineCollection(client); // must not throw on second call
});
