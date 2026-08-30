// Publishes each MavlinkTelemetryTick as the MavlinkTelemetryPayload JSON
// shape onto MQTT, under the same "vektor/sensors/..." prefix ingest-svc's
// mqttAdapter subscribes to (MQTT_TOPIC_FILTER=vektor/sensors/# in local
// dev). mqttAdapter treats the payload as opaque JSON — only fusion-svc's
// fromIot() knows to look for device_class: "mavlink" inside it.
import mqtt, { type MqttClient } from "mqtt";
import type { MavlinkTelemetryPayload } from "@vektor/shared";
import type { MavlinkTelemetryTick } from "./mavlinkSource.js";

export interface BridgeOptions {
  brokerUrl: string;
  topicPrefix: string;
  onPublish?: (topic: string, payload: MavlinkTelemetryPayload) => void;
  onError?: (err: Error) => void;
}

export interface BridgeHandle {
  client: MqttClient;
  publish: (tick: MavlinkTelemetryTick) => void;
  stop: () => Promise<void>;
}

export function startBridge(options: BridgeOptions): BridgeHandle {
  const client = mqtt.connect(options.brokerUrl);
  client.on("error", (err) => options.onError?.(err));

  const publish = (tick: MavlinkTelemetryTick): void => {
    const topic = `${options.topicPrefix}/${tick.systemId}`;
    const payload: MavlinkTelemetryPayload = {
      device_class: "mavlink",
      system_id: tick.systemId,
      lat: tick.lat,
      lon: tick.lon,
      alt_m: tick.altM,
      heading_deg: tick.headingDeg,
      groundspeed_mps: tick.groundspeedMps,
    };
    client.publish(topic, JSON.stringify(payload), { qos: 0 }, (err) => {
      if (err) options.onError?.(err);
      else options.onPublish?.(topic, payload);
    });
  };

  return {
    client,
    publish,
    stop: () => new Promise<void>((resolve) => client.end(false, {}, () => resolve())),
  };
}
