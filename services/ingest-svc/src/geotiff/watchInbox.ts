// Watches a drop directory and ingests any .tif/.tiff that lands in it —
// the "processed within 5s of upload" trigger (REQ-1.2) for a file-drop
// style ingest path, as opposed to SVC-001's continuous stream.
import { watch } from "node:fs";
import { join } from "node:path";
import { ingestGeoTiffFile, type IngestGeoTiffOptions } from "./ingestGeoTiff.js";
import type { GeoTiffIngestedEvent } from "@vektor/shared";

const TIFF_EXTENSIONS = new Set([".tif", ".tiff"]);

export interface WatchInboxHandle {
  stop: () => void;
}

export function watchGeoTiffInbox(
  inboxDir: string,
  options: IngestGeoTiffOptions,
  onIngested: (event: GeoTiffIngestedEvent) => void,
  onError: (err: Error) => void,
  // fs.watch's "rename" event fires the instant a file is created, often
  // before a large file's bytes are fully flushed to disk — this settle
  // delay avoids reading a partial file. Exposed for tests, which don't
  // need to wait out a production-sized delay.
  settleDelayMs = 200,
): WatchInboxHandle {
  const watcher = watch(inboxDir, (eventType, filename) => {
    if (!filename || eventType !== "rename") return;
    const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    if (!TIFF_EXTENSIONS.has(ext)) return;

    setTimeout(() => {
      ingestGeoTiffFile(join(inboxDir, filename), options).then(onIngested).catch(onError);
    }, settleDelayMs);
  });

  return { stop: () => watcher.close() };
}
