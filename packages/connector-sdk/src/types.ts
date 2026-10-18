// packages/connector-sdk/src/types.ts — NW-019.
//
// Every sensor adapter in ingest-svc today (RTSP, AIS, ADS-B, MQTT,
// GeoTIFF, field-PWA HTTP) was hand-written into the service, and each one
// independently re-implements the same five steps: build an event envelope
// with a fresh id, stamp `kafka_ts`, assert `sensor_ts` is sane, validate
// against a Zod schema, and produce to `{env}.vektor.{domain}.{action}`.
// Five copies of that is five places for a subtle difference to hide — and
// the differences are already there: the AIS adapter has no reconnection at
// all, so a dropped TCP feed silently stops the stream with the process
// still healthy.
//
// This interface is what a third party writes against. The contract is
// deliberately narrow: a connector produces domain events and knows nothing
// about Kafka, topic naming, envelope fields or validation. That is the
// SDK's job, and keeping it there is what stops an external contributor
// from inventing their own topic name or skipping the clock check.
import type { ZodType } from "zod";
import type { VektorEnv } from "@vektor/kafka";

/**
 * Where a connector's events go. Supplied by the connector; resolved to a
 * topic by the runtime, so a connector never names a topic itself.
 */
export interface EventSpec<T> {
  /** §12.3's {domain} — e.g. "modbus", "lorawan". */
  domain: string;
  /** §12.3's {action} — e.g. "telemetry", "position". */
  action: string;
  /**
   * Validated before publication, never after. A connector that emits a
   * malformed event finds out at the boundary rather than poisoning a
   * downstream consumer that has no way to attribute the problem back.
   */
  schema: ZodType<T>;
}

export interface ConnectorLogger {
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

/**
 * Handed to a connector at start. Everything it is allowed to do to the
 * outside world goes through here.
 */
export interface ConnectorContext {
  /** Identifies this connector instance's feed. Goes on every event. */
  readonly sensorId: string;
  readonly env: VektorEnv;
  readonly logger: ConnectorLogger;
  /**
   * Aborted when the runtime is shutting down. A long-lived connector
   * (a poll loop, a reconnect loop) must honour it; the SDK's own helpers
   * already do.
   */
  readonly signal: AbortSignal;

  /**
   * Publishes one event. Validates, stamps and routes it.
   *
   * Rejects if the event fails validation or the clock check, so a
   * connector can decide whether that is fatal for its feed. It does NOT
   * reject for a transient broker failure — the runtime counts those and
   * the connector should keep going rather than tear down a live feed
   * because one send failed.
   */
  publish<T>(spec: EventSpec<T>, event: T): Promise<void>;
}

/** What `start()` hands back so the runtime can shut the connector down. */
export interface ConnectorHandle {
  stop(): Promise<void> | void;
}

/**
 * The interface a connector implements. One method, because a connector
 * that needs more lifecycle than "start, and give me something to stop
 * you with" is usually two connectors.
 */
export interface Connector {
  /** Stable identifier — appears in logs, health output and config. */
  readonly name: string;
  start(ctx: ConnectorContext): Promise<ConnectorHandle> | ConnectorHandle;
}

/**
 * Per-connector counters. Deliberately counts REJECTED separately from
 * FAILED: a rejected event is the connector's own bug (bad shape, bad
 * clock) and will keep happening until someone fixes the code, while a
 * failed publish is usually the broker and will clear on its own. Rolling
 * them into one number is how a permanent defect hides inside what looks
 * like transient infrastructure noise.
 */
export interface ConnectorStats {
  readonly name: string;
  readonly sensorId: string;
  published: number;
  /** Failed schema validation or the sensor_ts clock check. */
  rejected: number;
  /** Accepted by the SDK, but the broker send failed. */
  failed: number;
  /** Reconnection attempts made by the SDK's own helpers. */
  reconnects: number;
  lastEventAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}
