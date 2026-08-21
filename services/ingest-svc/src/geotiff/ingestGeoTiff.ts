// SVC-002 (REQ-1.2): parses a GeoTIFF/SAR file's georeferencing metadata and
// publishes a GeoTiffIngestedEvent. Uses `geotiff` (pure JS, no native
// bindings) rather than the PRD's originally specified gdal-async — gdal-async
// ships no prebuilt binary for this Node ABI and its source-build fallback
// needs a node-gyp header download this sandbox's network doesn't reach, so
// it's not installable here. `geotiff` covers standard GeoTIFF/COG
// georeferencing correctly; it won't read GDAL's more exotic native SAR
// container formats (e.g. Sentinel-1 SAFE), which would need gdal-async's
// broader driver support once that dependency is actually installable.
import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as GeoTIFF from "geotiff";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import { GeoTiffIngestedEvent } from "@vektor/shared";

export interface IngestGeoTiffOptions {
  producer: Producer;
  env: VektorEnv;
  sensorId: string;
}

// GeoTIFF ModelTypeGeoKey values (GeoTIFF spec §6.3.1.1) — which of
// ProjectedCSTypeGeoKey / GeographicTypeGeoKey actually holds the EPSG code
// depends on this, they aren't both populated at once.
const MODEL_TYPE_PROJECTED = 1;
const MODEL_TYPE_GEOGRAPHIC = 2;

export async function ingestGeoTiffFile(
  filePath: string,
  options: IngestGeoTiffOptions,
): Promise<GeoTiffIngestedEvent> {
  const buffer = await readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();

  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox() as [number, number, number, number];
  const geoKeys = image.getGeoKeys() as Record<string, number> | null;
  const modelType = geoKeys?.GTModelTypeGeoKey;
  const crsEpsg =
    modelType === MODEL_TYPE_PROJECTED
      ? (geoKeys?.ProjectedCSTypeGeoKey ?? null)
      : modelType === MODEL_TYPE_GEOGRAPHIC
        ? (geoKeys?.GeographicTypeGeoKey ?? null)
        : null;

  const now = new Date();
  const event: GeoTiffIngestedEvent = {
    event_id: randomUUID(),
    sensor_id: options.sensorId,
    file_name: basename(filePath),
    bbox: { min_lon: minLon, min_lat: minLat, max_lon: maxLon, max_lat: maxLat },
    width_px: image.getWidth(),
    height_px: image.getHeight(),
    band_count: image.getSamplesPerPixel(),
    crs_epsg: crsEpsg,
    sensor_ts: now.toISOString(),
    kafka_ts: new Date().toISOString(),
  };

  assertValidSensorTs(event.sensor_ts, event.sensor_id, now);
  GeoTiffIngestedEvent.parse(event);

  await options.producer.send({
    topic: topicName(options.env, "imagery", "ingested"),
    messages: [{ key: options.sensorId, value: JSON.stringify(event) }],
  });

  return event;
}
