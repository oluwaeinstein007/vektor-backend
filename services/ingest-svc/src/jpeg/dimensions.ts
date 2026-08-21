// Reads width/height straight out of a JPEG frame's SOF0 marker instead of
// a separate ffprobe round-trip against the live source — ffmpeg's default
// MJPEG encoder always emits baseline-DCT frames (SOF0, marker 0xFFC0), and
// the bytes are already in hand from the frame extractor, so this is both
// simpler and more current than probing once at startup and assuming the
// resolution never changes.
export interface JpegDimensions {
  width: number;
  height: number;
}

const MARKER_SOF0 = 0xc0;
// Markers with no payload segment to skip over.
const STANDALONE_MARKERS = new Set([0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

export function parseJpegDimensions(frame: Buffer): JpegDimensions | null {
  let offset = 2; // skip the SOI marker (FF D8)

  while (offset < frame.length - 1) {
    if (frame[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = frame[offset + 1];
    if (marker === undefined) break;

    if (marker === MARKER_SOF0) {
      if (offset + 9 > frame.length) return null;
      const height = frame.readUInt16BE(offset + 5);
      const width = frame.readUInt16BE(offset + 7);
      return { width, height };
    }

    if (STANDALONE_MARKERS.has(marker)) {
      offset += 2;
      continue;
    }

    if (offset + 4 > frame.length) return null;
    const segmentLength = frame.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }

  return null;
}
