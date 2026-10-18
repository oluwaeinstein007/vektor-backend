// packages/connector-sdk/src/runtime.ts — NW-019.
//
// The half of a connector that is identical for every connector: envelope,
// clock check, validation, topic routing, publication, counting.
import { randomUUID } from "node:crypto";
import type { Producer } from "kafkajs";
import { assertValidSensorTs, topicName, type VektorEnv } from "@vektor/kafka";
import type {
  Connector,
  ConnectorContext,
  ConnectorHandle,
  ConnectorLogger,
  ConnectorStats,
  EventSpec,
} from "./types.js";

export class ConnectorEventError extends Error {}

export interface ConnectorRuntimeOptions {
  producer: Producer;
  env: VektorEnv;
  logger?: ConnectorLogger;
}

export interface RunningConnector {
  readonly name: string;
  readonly sensorId: string;
  readonly stats: Readonly<ConnectorStats>;
  stop(): Promise<void>;
}

const silentLogger: ConnectorLogger = { info() {}, warn() {}, error() {} };

/**
 * Fills in the envelope fields every VEKTOR sensor event carries.
 *
 * Only fills what is MISSING. A connector that knows its device's own
 * clock sets `sensor_ts` itself and that value is kept — overwriting it
 * with receipt time is how a real timestamp becomes a fake one, and
 * fusion-svc's watermark depends on the difference.
 */
function stampEnvelope(event: Record<string, unknown>, sensorId: string, now: Date): Record<string, unknown> {
  const stamped = { ...event };
  stamped.event_id ??= randomUUID();
  stamped.sensor_id ??= sensorId;
  stamped.sensor_ts ??= now.toISOString();
  // kafka_ts is always ours: it means "when this entered the bus", which a
  // connector is in no position to assert.
  stamped.kafka_ts = now.toISOString();
  return stamped;
}

export function createConnectorRuntime(options: ConnectorRuntimeOptions) {
  const logger = options.logger ?? silentLogger;
  const running: { entry: RunningConnector; stats: ConnectorStats }[] = [];

  async function run(connector: Connector, config: { sensorId: string }): Promise<RunningConnector> {
    const stats: ConnectorStats = {
      name: connector.name,
      sensorId: config.sensorId,
      published: 0,
      rejected: 0,
      failed: 0,
      reconnects: 0,
    };
    const controller = new AbortController();

    const ctx: ConnectorContext = {
      sensorId: config.sensorId,
      env: options.env,
      logger,
      signal: controller.signal,
      async publish<T>(spec: EventSpec<T>, event: T): Promise<void> {
        const now = new Date();
        const stamped = stampEnvelope(event as Record<string, unknown>, config.sensorId, now);

        let valid: T;
        try {
          // Clock check before schema: a plausible-looking event with a
          // sensor_ts from next week passes any schema and then sits in
          // fusion-svc's watermark window holding back every other sensor.
          assertValidSensorTs(stamped.sensor_ts as string, stamped.sensor_id as string, now);
          valid = spec.schema.parse(stamped);
        } catch (err) {
          stats.rejected += 1;
          stats.lastErrorAt = now.toISOString();
          stats.lastError = err instanceof Error ? err.message : String(err);
          logger.warn({ connector: connector.name, err }, "connector event rejected");
          // Thrown, not swallowed: this is the connector's own bug and it
          // should be able to decide whether its feed can continue.
          throw new ConnectorEventError(stats.lastError);
        }

        try {
          await options.producer.send({
            topic: topicName(options.env, spec.domain, spec.action),
            messages: [{ key: config.sensorId, value: JSON.stringify(valid) }],
          });
          stats.published += 1;
          stats.lastEventAt = now.toISOString();
        } catch (err) {
          // NOT rethrown. A broker blip must not tear down a live sensor
          // feed that is otherwise working — the event is lost, the
          // counter records it, and the next one is attempted normally.
          stats.failed += 1;
          stats.lastErrorAt = now.toISOString();
          stats.lastError = err instanceof Error ? err.message : String(err);
          logger.error({ connector: connector.name, err }, "connector publish failed");
        }
      },
    };

    const handle: ConnectorHandle = await connector.start(ctx);
    logger.info({ connector: connector.name, sensorId: config.sensorId }, "connector started");

    const entry: RunningConnector = {
      name: connector.name,
      sensorId: config.sensorId,
      stats,
      async stop() {
        controller.abort();
        await handle.stop();
        logger.info({ connector: connector.name, stats }, "connector stopped");
      },
    };
    running.push({ entry, stats });
    return entry;
  }

  return {
    run,
    /** Snapshot for a /healthz or /metrics surface. */
    health(): ConnectorStats[] {
      return running.map((r) => ({ ...r.stats }));
    },
    async stopAll(): Promise<void> {
      // Settled, not all: one connector refusing to stop must not leave
      // the rest running during a shutdown.
      await Promise.allSettled(running.map((r) => r.entry.stop()));
      running.length = 0;
    },
    /** Counts a reconnection against a running connector's stats. */
    trackReconnect(name: string): void {
      const found = running.find((r) => r.entry.name === name);
      if (found) found.stats.reconnects += 1;
    },
  };
}

export type ConnectorRuntime = ReturnType<typeof createConnectorRuntime>;
