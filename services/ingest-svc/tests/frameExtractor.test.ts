import { test } from "node:test";
import assert from "node:assert/strict";
import { MjpegFrameSplitter } from "../src/rtsp/frameExtractor.js";
import { parseJpegDimensions } from "../src/jpeg/dimensions.js";

function fakeJpeg(payload: number[] = [1, 2, 3]): Buffer {
  return Buffer.from([0xff, 0xd8, ...payload, 0xff, 0xd9]);
}

test("MjpegFrameSplitter yields a complete frame delivered in one chunk", () => {
  const splitter = new MjpegFrameSplitter();
  const frame = fakeJpeg();
  const out = splitter.push(frame);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], frame);
});

test("MjpegFrameSplitter yields two frames concatenated in one chunk", () => {
  const splitter = new MjpegFrameSplitter();
  const a = fakeJpeg([1]);
  const b = fakeJpeg([2, 2]);
  const out = splitter.push(Buffer.concat([a, b]));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
});

test("MjpegFrameSplitter reassembles a frame split across chunk boundaries", () => {
  const splitter = new MjpegFrameSplitter();
  const frame = fakeJpeg([9, 9, 9, 9]);
  const mid = Math.floor(frame.length / 2);

  const first = splitter.push(frame.subarray(0, mid));
  assert.equal(first.length, 0, "no complete frame yet — EOI hasn't arrived");

  const second = splitter.push(frame.subarray(mid));
  assert.equal(second.length, 1);
  assert.deepEqual(second[0], frame);
});

test("MjpegFrameSplitter discards leading garbage bytes before the first SOI", () => {
  const splitter = new MjpegFrameSplitter();
  const frame = fakeJpeg();
  const out = splitter.push(Buffer.concat([Buffer.from([0x00, 0x11, 0x22]), frame]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], frame);
});

test("parseJpegDimensions reads width/height from a real ffmpeg-encoded MJPEG frame", async () => {
  // A minimal but structurally real baseline JPEG (from a 4x2 encode),
  // rather than a hand-built fake — exercises the actual SOF0 byte layout
  // ffmpeg emits, not a shape this test invented to match the parser.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const { stdout } = await run(
    "ffmpeg",
    [
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48",
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );

  const dims = parseJpegDimensions(stdout as unknown as Buffer);
  assert.deepEqual(dims, { width: 64, height: 48 });
});

test("parseJpegDimensions returns null for a buffer with no SOF0 marker", () => {
  assert.equal(parseJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
});
