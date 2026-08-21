// SVC-001: pulls raw frames off a live RTSP/SRT source via fluent-ffmpeg.
//
// fluent-ffmpeg spawns `ffmpeg` and pipes its stdout as an MJPEG byte
// stream — there's no per-frame timestamp metadata at this layer, so
// `capturedAt` is stamped the moment a full JPEG frame boundary is detected
// in the pipe. That's the JS-observed capture time, not a hardware/RTP
// timestamp; a lower-level RTP-timestamp-based capture is future work if
// sub-frame accuracy ever matters more than "close enough to publish time."
import { PassThrough } from "node:stream";
import ffmpeg from "fluent-ffmpeg";

export interface ExtractedFrame {
  buffer: Buffer;
  frameNumber: number;
  capturedAt: Date;
}

export interface FrameExtractorOptions {
  sourceUrl: string;
  // RTSP-only. SRT sources connect via srt:// URLs and don't take this
  // option; fluent-ffmpeg/ffmpeg picks the right demuxer from the URL
  // scheme either way.
  rtspTransport?: "tcp" | "udp";
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

/**
 * Splits a raw MJPEG byte stream into individual JPEG frame buffers by
 * scanning for SOI/EOI markers — ffmpeg's MJPEG muxer concatenates frames
 * back-to-back over the pipe with no other framing.
 */
export class MjpegFrameSplitter {
  // Explicitly annotated: without it, TS narrows the field to the
  // ArrayBuffer-backed Buffer<ArrayBuffer> returned by Buffer.alloc(0),
  // which then rejects assigning the plain Buffer<ArrayBufferLike> chunks
  // passed into push().
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];

    for (;;) {
      const start = this.buffer.indexOf(JPEG_SOI);
      if (start === -1) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      const end = this.buffer.indexOf(JPEG_EOI, start + JPEG_SOI.length);
      if (end === -1) {
        this.buffer = this.buffer.subarray(start);
        break;
      }
      const frameEnd = end + JPEG_EOI.length;
      frames.push(Buffer.from(this.buffer.subarray(start, frameEnd)));
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return frames;
  }
}

export interface FrameExtractorHandle {
  stop: () => void;
}

export function extractFrames(
  options: FrameExtractorOptions,
  onFrame: (frame: ExtractedFrame) => void,
  onError: (err: Error) => void,
): FrameExtractorHandle {
  const splitter = new MjpegFrameSplitter();
  let frameNumber = 0;
  const output = new PassThrough();

  const inputOptions = options.rtspTransport ? ["-rtsp_transport", options.rtspTransport] : [];

  const command = ffmpeg(options.sourceUrl)
    .inputOptions(inputOptions)
    .outputOptions(["-f", "mjpeg", "-q:v", "5"])
    .on("error", (err: Error) => onError(err));

  command.pipe(output, { end: true });

  output.on("data", (chunk: Buffer) => {
    for (const frameBuffer of splitter.push(chunk)) {
      frameNumber += 1;
      onFrame({ buffer: frameBuffer, frameNumber, capturedAt: new Date() });
    }
  });

  return {
    stop: () => command.kill("SIGKILL"),
  };
}
