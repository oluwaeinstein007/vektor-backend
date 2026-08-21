// §13.1 REST endpoints this service owns:
//   GET  /api/v1/entities            list active entities (paginated; filter by class, affiliation, bbox)
//   GET  /api/v1/entities/:id        full entity detail
//   POST /api/v1/entities/:id/tag    add operator tag
//
// Auth (Analyst+ RBAC per §13.1) isn't wired up yet — auth-svc/Keycloak
// don't exist as a repo dependency this service can call yet. Every handler
// below is written as if a `request.user` decorator will exist; there's a
// TODO at the one place that actually needs it once auth-svc lands.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { Entity } from "@vektor/shared";
import { getEntity, listEntities, tagEntity } from "../queries/entities.js";

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
    { schema: { querystring: ListEntitiesQuery } },
    async (request) => {
      const { class: classification, affiliation, bbox, page, limit } = request.query;
      const rows = await listEntities(app.db, {
        classification,
        affiliation,
        bbox,
        limit,
        offset: (page - 1) * limit,
      });
      return { data: rows, page, limit };
    },
  );

  typedApp.get(
    "/api/v1/entities/:id",
    { schema: { params: EntityIdParams } },
    async (request, reply) => {
      const entity = await getEntity(app.db, request.params.id);
      if (!entity) return reply.code(404).send({ error: "entity not found" });
      return entity;
    },
  );

  typedApp.post(
    "/api/v1/entities/:id/tag",
    { schema: { params: EntityIdParams, body: TagEntityBody } },
    async (request, reply) => {
      // TODO(auth-svc): reject here with 403 if request.user's role isn't
      // Analyst+ (REQ table, §13.1) — no auth middleware exists yet to
      // populate request.user, so there's nothing to check against.
      const updated = await tagEntity(app.db, request.params.id, request.body.tag);
      if (!updated) return reply.code(404).send({ error: "entity not found" });
      return updated;
    },
  );
};

export default entitiesRoutes;

// Re-exported so callers of this route file get the wire-contract type
// alongside the route registration, without a separate import from
// @vektor/shared.
export type { Entity };
