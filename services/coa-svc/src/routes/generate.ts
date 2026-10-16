// Not in 07-data-api.md's REST table (Epic 4 only specifies the
// retrieve/approve/reject endpoints, not the trigger) — every COA needs
// *something* to kick off generateCoa(), and §9.7's data flow diagram says
// "coa-svc triggered by alert or operator request". This is the
// operator-request path.
//
// STALE-COMMENT CORRECTION (2026-10-16): this used to say "alert-svc
// (Phase 5, not yet built) will be the other caller once it exists".
// alert-svc now exists and does NOT call this endpoint — grep for
// `coa/generate` or `COA_SVC_URL` across the repo and this file is the
// only hit. The automatic trigger §9.7's data-flow diagram describes
// ("coa-svc triggered by alert or operator request") was never built.
//
// That matters beyond tidiness: it means G1's "sensor-to-decision in
// under 60 seconds" has a human in the middle of it today. The machine
// path runs sensor → fusion → operator screen; COA generation starts only
// when someone clicks. Measuring wall-clock across that boundary would be
// measuring operator reaction time and calling it system latency — see
// vektor-docs/docs/15-perf-results.md §26a, which measures the machine leg
// only and says so.
//
// Wiring alert-svc → here would close the loop, and is deliberately NOT
// done as a side-effect of documentation work: auto-generating a course of
// action in response to an alert is a product and safety decision on a
// system whose entire premise is that a human approves every recommended
// action (00-vision.md §3.2's first permanent anti-goal).
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
