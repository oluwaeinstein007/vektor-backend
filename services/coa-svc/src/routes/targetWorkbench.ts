// SVC-012 — REQ-4.1: "Rank active entities in Target Workbench by
// threat/priority score ... Ranking refreshes ≤ every 5s". No REST contract
// for this exists in 07-data-api.md (Epic 4 predates a finalized endpoint
// list for it), so this follows the blue-force-assets precedent
// (fusion-svc/src/blueforce/routes.ts): recomputed fresh on every request,
// cheap enough (a handful of arithmetic ops per entity, no external calls)
// that a client polling every <5s satisfies the acceptance criteria without
// a push mechanism.
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { RankedEntity } from "@vektor/shared";
import { z } from "zod";
import { rankEntities } from "../threat/scoring.js";
import { listActiveEntities, listBlueForceAssets } from "../db/readQueries.js";
import { toWireEntity, toWireBlueForceAsset } from "../db/mappers.js";

const targetWorkbenchRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/target-workbench/ranking",
    { schema: { response: { 200: z.array(RankedEntity) } } },
    async () => {
      const [entityRows, assetRows] = await Promise.all([
        listActiveEntities(app.db),
        listBlueForceAssets(app.db),
      ]);
      const entities = entityRows.map(toWireEntity);
      const blueForceAssets = assetRows.map(toWireBlueForceAsset);
      return rankEntities(entities, { now: new Date(), blueForceAssets });
    },
  );
};

export default targetWorkbenchRoutes;
