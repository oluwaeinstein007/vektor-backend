import { create } from "zustand";
import type { Entity } from "@vektor/shared";

export interface EntityState {
  entities: Map<string, Entity>;
  upsertEntity: (entity: Entity) => void;
  removeEntity: (entityId: string) => void;
}

export const useEntityStore = create<EntityState>((set) => ({
  entities: new Map(),
  upsertEntity: (entity) =>
    set((state) => {
      const next = new Map(state.entities);
      next.set(entity.entity_id, entity);
      return { entities: next };
    }),
  removeEntity: (entityId) =>
    set((state) => {
      if (!state.entities.has(entityId)) return state;
      const next = new Map(state.entities);
      next.delete(entityId);
      return { entities: next };
    }),
}));
