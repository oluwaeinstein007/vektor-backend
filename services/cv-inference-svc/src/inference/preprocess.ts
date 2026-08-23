// ML-002: JPEG bytes -> a letterboxed, normalized CHW tensor matching
// YOLOv8's expected input. Letterboxing (resize-to-fit + pad, rather than
// a plain stretch-to-square) preserves the source aspect ratio — a plain
// stretch would systematically distort object shapes and quietly hurt
// detection accuracy (REQ-2.2's mAP target). sharp's `fit: "contain"`
// already implements the resize+pad; this module just also tracks the
// scale/pad offsets so postprocess.ts can map model-space boxes back to
// the original frame's pixel coordinates.
import sharp from "sharp";

export interface PreprocessedImage {
  tensorData: Float32Array; // CHW, RGB, normalized to [0,1]
  targetSize: number;
  originalWidth: number;
  originalHeight: number;
  scale: number;
  padX: number;
  padY: number;
}

// YOLO's conventional letterbox padding color (mid-gray) — chosen upstream
// by Ultralytics because it's roughly neutral for ImageNet-trained backbones.
const LETTERBOX_COLOR = { r: 114, g: 114, b: 114 };

export async function preprocessFrame(jpegBuffer: Buffer, targetSize = 640): Promise<PreprocessedImage> {
  const image = sharp(jpegBuffer);
  const metadata = await image.metadata();
  const originalWidth = metadata.width ?? targetSize;
  const originalHeight = metadata.height ?? targetSize;

  const scale = Math.min(targetSize / originalWidth, targetSize / originalHeight);
  const resizedWidth = Math.round(originalWidth * scale);
  const resizedHeight = Math.round(originalHeight * scale);
  const padX = Math.floor((targetSize - resizedWidth) / 2);
  const padY = Math.floor((targetSize - resizedHeight) / 2);

  const { data } = await image
    .resize(targetSize, targetSize, { fit: "contain", background: LETTERBOX_COLOR })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // `data` is interleaved HWC uint8 RGB; ONNX models expect planar CHW float32.
  const pixelCount = targetSize * targetSize;
  const tensorData = new Float32Array(3 * pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    tensorData[i] = data[i * 3]! / 255;
    tensorData[pixelCount + i] = data[i * 3 + 1]! / 255;
    tensorData[2 * pixelCount + i] = data[i * 3 + 2]! / 255;
  }

  return { tensorData, targetSize, originalWidth, originalHeight, scale, padX, padY };
}
