import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkDoctrine } from "../src/chunk.js";

test("a short document is a single chunk", () => {
  const chunks = chunkDoctrine("Paragraph one.\n\nParagraph two.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, "Paragraph one.\n\nParagraph two.");
  assert.equal(chunks[0]!.chunk_index, 0);
});

test("chunks never split a paragraph in half", () => {
  const long = "word ".repeat(50).trim();
  const doc = [long, long, long].join("\n\n");
  const chunks = chunkDoctrine(doc, 100);
  for (const chunk of chunks) {
    // every chunk's text must be composed of whole paragraphs from the source
    assert.ok(doc.includes(chunk.text.split("\n\n")[0]!));
  }
});

test("chunk_index is sequential starting at 0", () => {
  const doc = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} content here.`).join("\n\n");
  const chunks = chunkDoctrine(doc, 30);
  chunks.forEach((chunk, i) => assert.equal(chunk.chunk_index, i));
});

test("empty input produces no chunks", () => {
  assert.deepEqual(chunkDoctrine(""), []);
  assert.deepEqual(chunkDoctrine("   \n\n  "), []);
});

test("a paragraph longer than maxChars becomes its own chunk rather than being dropped", () => {
  const huge = "x".repeat(2000);
  const chunks = chunkDoctrine(huge, 800);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.text, huge);
});

test("consecutive short paragraphs are grouped into one chunk up to maxChars", () => {
  const doc = ["short one", "short two", "short three"].join("\n\n");
  const chunks = chunkDoctrine(doc, 1000);
  assert.equal(chunks.length, 1);
});
