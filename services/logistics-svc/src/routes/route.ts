// SVC-019 REST surface — 07-data-api.md §13.1: POST /api/v1/logistics/route.
// Also exposes a hazard-flag toggle (no REST spec for this exists in
// 07-data-api.md — same "no PRD spec, follow existing route pattern" note
// fusion-svc's blueforce/routes.ts already made for its own no-strike-zone
// CRUD) so REQ-6.2's "avoiding flagged threat/hazard zones" is actually
// exercisable end-to-end over HTTP, not just from a test importing
// setEdgeBlocked directly.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Sql } from "postgres";
import { RouteRequest, RouteResult } from "@vektor/shared";
import { findRoute, setEdgeBlocked } from "../routing/findRoute.js";

const ErrorResponse = z.object({ error: z.string() });
const EdgeIdParams = z.object({ id: z.coerce.number().int() });
const BlockBody = z.object({ blocked: z.boolean() });

export default function buildRouteRoutes(routingSql: Sql): FastifyPluginAsync {
  return async (app) => {
    const typedApp = app.withTypeProvider<ZodTypeProvider>();

    typedApp.post(
      "/api/v1/logistics/route",
      { schema: { body: RouteRequest, response: { 200: RouteResult } } },
      async (request) => {
        return findRoute(routingSql, request.body);
      },
    );

    typedApp.post(
      "/api/v1/logistics/road-edges/:id/block",
      { schema: { params: EdgeIdParams, body: BlockBody, response: { 200: z.object({ ok: z.literal(true) }), 404: ErrorResponse } } },
      async (request, reply) => {
        const ok = await setEdgeBlocked(routingSql, request.params.id, request.body.blocked);
        if (!ok) return reply.code(404).send({ error: "edge not found" });
        return { ok: true as const };
      },
    );
  };
}
