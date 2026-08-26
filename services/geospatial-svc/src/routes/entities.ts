// §13.1 REST endpoints this service owns (all Analyst+ per SEC-003):
//   GET  /api/v1/entities            list active entities (paginated; filter by class, affiliation, bbox)
//   GET  /api/v1/entities/:id        full entity detail
//   POST /api/v1/entities/:id/tag    add operator tag
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { Entity } from "@vektor/shared";
import { getEntity, listEntities, tagEntity } from "../queries/entities.js";
import { toWireEntity } from "../mappers/entity.js";

const ErrorResponse = z.object({ error: z.string() });

// Response schemas are the enforcement mechanism for REQ-9.1 ("100% of
// public endpoints ... schema-validated"): fastify-type-provider-zod
// serializes through these, so a handler that returns a shape Entity
// doesn't match fails at response time instead of shipping silently.
const ListEntitiesResponse = z.object({
  data: z.array(Entity),
  page: z.number().int(),
  limit: z.number().int(),
});

const BboxQueryParam = z
  .string()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, "expected min_lon,min_lat,max_lon,max_lat")
  .transform((s) => {
    const [min_lon, min_lat, max_lon, max_lat] = s.split(",").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    return { min_lon, min_lat, max_lon, max_lat };
  });

const ListEntitiesQuery = z.object({
  class: z.string().optional(),
  affiliation: z.enum(["UNKNOWN", "FRIENDLY", "HOSTILE", "NEUTRAL"]).optional(),
  bbox: BboxQueryParam.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const EntityIdParams = z.object({
  id: z.string().uuid(),
});

const TagEntityBody = z.object({
  tag: z.string().min(1).max(64),
});

const entitiesRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/entities",
    {
      preHandler: app.requireRole("analyst+"),
      schema: { querystring: ListEntitiesQuery, response: { 200: ListEntitiesResponse } },
    },
    async (request) => {
      const { class: classification, affiliation, bbox, page, limit } = request.query;
      const rows = await listEntities(app.db, {
        classification,
        affiliation,
        bbox,
        limit,
        offset: (page - 1) * limit,
      });
      return { data: rows.map(toWireEntity), page, limit };
    },
  );

  typedApp.get(
    "/api/v1/entities/:id",
    {
      preHandler: app.requireRole("analyst+"),
      schema: { params: EntityIdParams, response: { 200: Entity, 404: ErrorResponse } },
    },
    async (request, reply) => {
      const entity = await getEntity(app.db, request.params.id);
      if (!entity) return reply.code(404).send({ error: "entity not found" });
      return toWireEntity(entity);
    },
  );

  typedApp.post(
    "/api/v1/entities/:id/tag",
    {
      preHandler: app.requireRole("analyst+"),
      schema: {
        params: EntityIdParams,
        body: TagEntityBody,
        response: { 200: Entity, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const updated = await tagEntity(app.db, request.params.id, request.body.tag);
      if (!updated) return reply.code(404).send({ error: "entity not found" });
      return toWireEntity(updated);
    },
  );
};

export default entitiesRoutes;

// Re-exported so callers of this route file get the wire-contract type
// alongside the route registration, without a separate import from
// @vektor/shared.
export type { Entity };
