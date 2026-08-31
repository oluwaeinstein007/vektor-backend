// The Socket.io gateway apps/web's FE-002 (Phase 1) was built against but
// never had — see vektor-project-overview memory: FE-002 was verified with
// a temporary test emitter "since no backend gateway emits these events yet
// (fusion-svc, Phase 3)". This is that gateway. Every emit is routed
// through the same Zod schema apps/web validates against (§13.2,
// @vektor/shared's ServerToClientEvents) so a shape bug here fails loudly
// in fusion-svc's own tests instead of silently reaching the dashboard.
//
// API-002/REQ-9.2: "WebSocket subscription API scoped to a bounding box...
// client receives only events within its subscribed AOI." The
// `subscribe:area`/`unsubscribe` client->server events were already part of
// vektor-proto's §13.2 contract (`ClientToServerEvents`) since Phase 1/3,
// but this gateway only ever broadcast unconditionally to every connected
// socket until this phase — the contract existed without a server-side
// implementation behind it.
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { Entity, EntityUpdatedEvent, EntityLostEvent, SensorHealth, BoundingBox, VideoFrameSocketEvent, type Position } from "@vektor/shared";

function withinBbox(position: Position, bbox: BoundingBox): boolean {
  return (
    position.lat >= bbox.min_lat &&
    position.lat <= bbox.max_lat &&
    position.lon >= bbox.min_lon &&
    position.lon <= bbox.max_lon
  );
}

export class FusionGateway {
  private readonly io: SocketIOServer;
  // No entry (or an entry with bbox: null) means "unsubscribed" — receives
  // every position-bearing event, matching the pre-API-002 broadcast
  // behavior as the default so an existing client that never calls
  // subscribe:area doesn't silently start missing events.
  private readonly subscriptions = new Map<string, BoundingBox | null>();

  constructor(httpServer: HttpServer) {
    this.io = new SocketIOServer(httpServer, { transports: ["websocket"] });

    this.io.on("connection", (socket: Socket) => {
      this.subscriptions.set(socket.id, null);

      socket.on("subscribe:area", (payload: unknown) => {
        // A malformed bbox from a misbehaving client leaves that socket's
        // existing subscription (or lack of one) untouched rather than
        // crashing the gateway process over one bad client message.
        const result = BoundingBox.safeParse(payload);
        if (result.success) this.subscriptions.set(socket.id, result.data);
      });

      socket.on("unsubscribe", () => {
        this.subscriptions.set(socket.id, null);
      });

      socket.on("disconnect", () => {
        this.subscriptions.delete(socket.id);
      });
    });
  }

  /** Position-bearing events go only to sockets with no AOI set, or whose AOI contains this position — REQ-9.2's actual scoping. */
  private emitScoped<Payload>(eventName: "entity:new" | "entity:updated" | "entity:lost", payload: Payload, position: Position): void {
    for (const [socketId, bbox] of this.subscriptions) {
      if (bbox && !withinBbox(position, bbox)) continue;
      this.io.to(socketId).emit(eventName, payload);
    }
  }

  emitEntityNew(entity: Entity): void {
    const parsed = Entity.parse(entity);
    this.emitScoped("entity:new", parsed, parsed.position);
  }

  emitEntityUpdated(entityId: string, changedFields: string[], entity: Entity): void {
    const parsed = EntityUpdatedEvent.parse({ entity_id: entityId, changed_fields: changedFields, entity });
    this.emitScoped("entity:updated", parsed, parsed.entity.position);
  }

  emitEntityLost(entityId: string, lastPosition: Entity["position"], ts: string): void {
    const parsed = EntityLostEvent.parse({ entity_id: entityId, last_position: lastPosition, ts });
    this.emitScoped("entity:lost", parsed, parsed.last_position);
  }

  // Sensor health and alerts are deliberately NOT AOI-scoped — a sensor
  // going degraded/offline, or a new alert firing, is global operational
  // awareness an operator needs regardless of which part of the map their
  // viewport currently shows, unlike per-entity position updates. Not in
  // 07-data-api.md's table (REQ-9.2 only specifies entity events), so this
  // is a documented interpretation, not a spec transcription.
  emitSensorStatus(health: SensorHealth): void {
    this.io.emit("sensor:status", SensorHealth.parse(health));
  }

  // Not AOI-scoped, same reasoning as sensor:status above — a live camera
  // panel is a fixed dashboard element an operator watches regardless of
  // map viewport, not a per-position stream tied to what's currently framed.
  emitVideoFrame(frame: VideoFrameSocketEvent): void {
    this.io.emit("video:frame", VideoFrameSocketEvent.parse(frame));
  }

  /** Number of currently-connected sockets with an active AOI subscription — exposed for tests/metrics, not part of the wire contract. */
  get subscribedCount(): number {
    return Array.from(this.subscriptions.values()).filter((bbox) => bbox !== null).length;
  }

  async close(): Promise<void> {
    await this.io.close();
  }
}
