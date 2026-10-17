// NW-018 (UC-2.2) — the historical read surface. All Analyst+ per SEC-003's
// role table, same as every other route this service owns.
//
//   GET /api/v1/entities/history/coverage        what history exists at all
//   GET /api/v1/entities/at                      every entity at one instant
//   GET /api/v1/entities/:id/history             one entity's track
//   GET /api/v1/entities/:id/pattern-of-life     dwell clusters
//
// Route ordering note: /api/v1/entities/history/coverage is registered
// BEFORE /api/v1/entities/:id/history. Fastify's radix router prefers a
// static segment over a parameter at the same position, so this happens to
// work either way — but relying on that is how "history" silently starts
// being parsed as an :id the day someone reorders them.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import mgrsPkg from "mgrs";
import {
  EntityHistoryResponse,
  EntitySnapshotResponse,
  HistoryCoverageResponse,
  PatternOfLifeResponse,
} from "@vektor/shared";
import {
  queryEntityTrack,
  querySnapshotAt,
  queryHistoryCoverage,
  queryPatternOfLife,
} from "./queries.js";

const { forward: toMgrs } = mgrsPkg;

const ErrorResponse = z.object({ error: z.string() });
const EntityIdParams = z.object({ id: z.string().uuid() });

const BboxQueryParam = z
  .string()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, "expected min_lon,min_lat,max_lon,max_lat")
  .transform((s) => {
    const [min_lon, min_lat, max_lon, max_lat] = s.split(",").map(Number) as [number, number, number, number];
    return { min_lon, min_lat, max_lon, max_lat };
  });

const HistoryQuery = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    max_points: z.coerce.number().int().positive().max(50_000).default(2_000),
    simplify_tolerance_m: z.coerce.number().positive().optional(),
  })
  // Caught here rather than in the query: an inverted range silently
  // returns zero rows, which reads to the operator as "this entity has no
  // history" instead of "your request was backwards".
  .refine((q) => Date.parse(q.from) <= Date.parse(q.to), {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

const SnapshotQuery = z.object({
  ts: z.string().datetime(),
  bbox: BboxQueryParam.optional(),
  max_staleness_s: z.coerce.number().int().positive().default(300),
});

const PatternOfLifeQuery = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    cluster_radius_m: z.coerce.number().positive().default(150),
    min_dwell_s: z.coerce.number().int().positive().default(300),
  })
  .refine((q) => Date.parse(q.from) <= Date.parse(q.to), {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

const historyRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/entities/history/coverage",
    {
      preHandler: app.requireRole("analyst+"),
      schema: { response: { 200: HistoryCoverageResponse } },
    },
    async () => queryHistoryCoverage(app.db),
  );

  typedApp.get(
    "/api/v1/entities/at",
    {
      preHandler: app.requireRole("analyst+"),
      schema: { querystring: SnapshotQuery, response: { 200: EntitySnapshotResponse } },
    },
    async (request) => {
      const { ts, bbox, max_staleness_s } = request.query;
      const entries = await querySnapshotAt(app.db, {
        ts: new Date(ts),
        bbox,
        maxStalenessS: max_staleness_s,
      });

      // mgrs is computed, never stored (see schema/entities.ts) — filled
      // here through the same `mgrs` package mappers/entity.ts uses, so
      // this service has one implementation of it rather than two.
      return {
        ts,
        entities: entries.map((entry) => ({
          ...entry,
          position: { ...entry.position, mgrs: toMgrs([entry.position.lon, entry.position.lat]) },
        })),
      };
    },
  );

  typedApp.get(
    "/api/v1/entities/:id/history",
    {
      preHandler: app.requireRole("analyst+"),
      schema: {
        params: EntityIdParams,
        querystring: HistoryQuery,
        response: { 200: EntityHistoryResponse, 404: ErrorResponse },
      },
    },
    async (request, reply) => {
      const { from, to, max_points, simplify_tolerance_m } = request.query;
      const track = await queryEntityTrack(app.db, {
        entityId: request.params.id,
        from: new Date(from),
        to: new Date(to),
        maxPoints: max_points,
        simplifyToleranceM: simplify_tolerance_m,
      });

      // 404 means "no history for this entity in this window", which is a
      // real answer and distinct from the route being absent — the client
      // (vektor-web's history-client.ts) tells those apart to decide
      // whether playback is unavailable or merely empty.
      if (!track) return reply.code(404).send({ error: "no history for this entity in the requested window" });
      return track;
    },
  );

  typedApp.get(
    "/api/v1/entities/:id/pattern-of-life",
    {
      preHandler: app.requireRole("analyst+"),
      schema: {
        params: EntityIdParams,
        querystring: PatternOfLifeQuery,
        response: { 200: PatternOfLifeResponse },
      },
    },
    async (request) => {
      const { from, to, cluster_radius_m, min_dwell_s } = request.query;
      const fromDate = new Date(from);
      const toDate = new Date(to);

      const clusters = await queryPatternOfLife(app.db, {
        entityId: request.params.id,
        from: fromDate,
        to: toDate,
        clusterRadiusM: cluster_radius_m,
        minDwellS: min_dwell_s,
      });

      const windowS = Math.max(1, (toDate.getTime() - fromDate.getTime()) / 1000);
      const dwellS = clusters.reduce((sum, c) => sum + c.total_dwell_s, 0);

      return {
        entity_id: request.params.id,
        from,
        to,
        clusters,
        // Capped at 1: overlapping clusters can sum past the window, and a
        // "107% of the time spent stationary" figure destroys trust in
        // every other number on the screen.
        dwell_fraction: Math.min(1, dwellS / windowS),
      };
    },
  );
};

export default historyRoutes;
