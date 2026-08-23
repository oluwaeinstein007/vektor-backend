// The Socket.io gateway apps/web's FE-002 (Phase 1) was built against but
// never had — see vektor-project-overview memory: FE-002 was verified with
// a temporary test emitter "since no backend gateway emits these events yet
// (fusion-svc, Phase 3)". This is that gateway. Every emit is routed
// through the same Zod schema apps/web validates against (§13.2,
// @vektor/shared's ServerToClientEvents) so a shape bug here fails loudly
// in fusion-svc's own tests instead of silently reaching the dashboard.
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { Entity, EntityUpdatedEvent, EntityLostEvent, SensorHealth } from "@vektor/shared";

export class FusionGateway {
  private readonly io: SocketIOServer;

  constructor(httpServer: HttpServer) {
    this.io = new SocketIOServer(httpServer, { transports: ["websocket"] });
  }

  emitEntityNew(entity: Entity): void {
    this.io.emit("entity:new", Entity.parse(entity));
  }

  emitEntityUpdated(entityId: string, changedFields: string[], entity: Entity): void {
    this.io.emit(
      "entity:updated",
      EntityUpdatedEvent.parse({ entity_id: entityId, changed_fields: changedFields, entity }),
    );
  }

  emitEntityLost(entityId: string, lastPosition: Entity["position"], ts: string): void {
    this.io.emit("entity:lost", EntityLostEvent.parse({ entity_id: entityId, last_position: lastPosition, ts }));
  }

  emitSensorStatus(health: SensorHealth): void {
    this.io.emit("sensor:status", SensorHealth.parse(health));
  }

  async close(): Promise<void> {
    await this.io.close();
  }
}
