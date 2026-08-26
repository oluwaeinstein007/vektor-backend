// Not in 07-data-api.md's REST table (Epic 4 only specifies the
// retrieve/approve/reject endpoints, not the trigger) — every COA needs
// *something* to kick off generateCoa(), and §9.7's data flow diagram says
// "coa-svc triggered by alert or operator request". This is the
// operator-request path; alert-svc (Phase 5, not yet built) will be the
// other caller once it exists, hitting the same endpoint.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { COA } from "@vektor/shared";
import type { QdrantClient } from "@vektor/qdrant";
import type { CoaMode } from "../llm/generateCoa.js";
import { generateCoa } from "../llm/generateCoa.js";
import { listActiveEntities, listBlueForceAssets, getEntityById } from "../db/readQueries.js";
import { toWireEntity, toWireBlueForceAsset } from "../db/mappers.js";
import { fetchNoStrikeZones } from "../context/fetchNoStrikeZones.js";

const GenerateBody = z.object({
  target_entity_id: z.string().uuid(),
  num_options: z.number().int().min(1).max(10).optional(),
});

const ErrorResponse = z.object({ error: z.string() });

const generateRoutes: FastifyPluginAsync<{
  qdrant: QdrantClient;
  mode: CoaMode;
  fusionSvcUrl: string;
}> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/api/v1/coa/generate",
    // Not in 07-data-api.md's table (see file header); Analyst+ by analogy
    // to the rest of this service's Commander/Analyst+ split.
    { preHandler: app.requireRole("analyst+"), schema: { body: GenerateBody, response: { 200: COA, 404: ErrorResponse } } },
    async (request, reply) => {
      const targetRow = await getEntityById(app.db, request.body.target_entity_id);
      if (!targetRow) return reply.code(404).send({ error: "target entity not found" });

      const [entityRows, assetRows, noStrikeZones] = await Promise.all([
        listActiveEntities(app.db),
        listBlueForceAssets(app.db),
        fetchNoStrikeZones(opts.fusionSvcUrl).catch(() => []), // degrade, don't fail COA generation over a fetch blip
      ]);

      const coa = await generateCoa(
        { db: app.db, qdrant: opts.qdrant, mode: opts.mode },
        {
          targetEntity: toWireEntity(targetRow),
          allEntities: entityRows.map(toWireEntity),
          blueForceAssets: assetRows.map(toWireBlueForceAsset),
          noStrikeZones,
          numOptions: request.body.num_options,
        },
      );

      return coa;
    },
  );
};

export default generateRoutes;
