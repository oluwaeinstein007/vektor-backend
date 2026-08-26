// SVC-020 REST surface — REQ-7.3: raw data export (CSV, GeoJSON).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { queryEntitiesForExport } from "../export/query.js";
import { toCsv } from "../export/csv.js";
import { toGeoJson } from "../export/geojson.js";

const ExportQuery = z.object({
  format: z.enum(["csv", "geojson"]),
  from: z.string().datetime(),
  to: z.string().datetime(),
  min_lon: z.coerce.number().optional(),
  min_lat: z.coerce.number().optional(),
  max_lon: z.coerce.number().optional(),
  max_lat: z.coerce.number().optional(),
});

const exportRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/export",
    // Not in 07-data-api.md's table; Analyst+ — raw entity export carries
    // the same SENSITIVE classification (§14.3) as /api/v1/entities.
    { preHandler: app.requireRole("analyst+"), schema: { querystring: ExportQuery } },
    async (request, reply) => {
      const { format, from, to, min_lon, min_lat, max_lon, max_lat } = request.query;
      const bbox =
        min_lon !== undefined && min_lat !== undefined && max_lon !== undefined && max_lat !== undefined
          ? { min_lon, min_lat, max_lon, max_lat }
          : undefined;

      const rows = await queryEntitiesForExport(app.db, { from: new Date(from), to: new Date(to), bbox });

      if (format === "csv") {
        return reply.type("text/csv").send(toCsv(rows));
      }
      return reply.type("application/geo+json").send(toGeoJson(rows));
    },
  );
};

export default exportRoutes;
