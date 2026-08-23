// SVC-010 REST surface — REQ-3.3. No REST spec for this exists in
// 07-data-api.md (no feed in the PRD publishes friendly-asset positions
// automatically; this is an operator-managed registry), so these routes
// follow geospatial-svc's routes/entities.ts pattern: fastify-type-provider-zod
// response schemas as the REQ-9.1 enforcement mechanism.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { BlueForceAsset, NoStrikeZone } from "@vektor/shared";
import {
  listBlueForceAssets,
  upsertBlueForceAsset,
  deleteBlueForceAsset,
  listNoStrikeZones,
  createManualZone,
  deleteNoStrikeZone,
} from "./queries.js";
import { toWireBlueForceAsset, toWireNoStrikeZone } from "./mappers.js";

const ErrorResponse = z.object({ error: z.string() });

const AssetIdParams = z.object({ id: z.string().uuid() });
const ZoneIdParams = z.object({ id: z.string().uuid() });

const UpsertAssetBody = z.object({
  callsign: z.string().min(1),
  classification: z.string().min(1),
  position: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), alt_m: z.number() }),
  buffer_radius_m: z.number().positive(),
});

const CreateZoneBody = z.object({
  name: z.string().min(1),
  polygon: z.array(z.tuple([z.number(), z.number()])).min(4),
});

const blueForceRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/blue-force-assets",
    { schema: { response: { 200: z.array(BlueForceAsset) } } },
    async () => {
      const rows = await listBlueForceAssets(app.db);
      return rows.map(toWireBlueForceAsset);
    },
  );

  typedApp.post(
    "/api/v1/blue-force-assets",
    { schema: { body: UpsertAssetBody, response: { 200: BlueForceAsset } } },
    async (request) => {
      const row = await upsertBlueForceAsset(app.db, request.body);
      return toWireBlueForceAsset(row);
    },
  );

  typedApp.put(
    "/api/v1/blue-force-assets/:id",
    { schema: { params: AssetIdParams, body: UpsertAssetBody, response: { 200: BlueForceAsset } } },
    async (request) => {
      const row = await upsertBlueForceAsset(app.db, { asset_id: request.params.id, ...request.body });
      return toWireBlueForceAsset(row);
    },
  );

  typedApp.delete(
    "/api/v1/blue-force-assets/:id",
    { schema: { params: AssetIdParams, response: { 204: z.void(), 404: ErrorResponse } } },
    async (request, reply) => {
      const deleted = await deleteBlueForceAsset(app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "asset not found" });
      return reply.code(204).send();
    },
  );

  typedApp.get(
    "/api/v1/no-strike-zones",
    { schema: { response: { 200: z.array(NoStrikeZone) } } },
    async () => {
      const rows = await listNoStrikeZones(app.db);
      return rows.map(toWireNoStrikeZone);
    },
  );

  typedApp.post(
    "/api/v1/no-strike-zones",
    { schema: { body: CreateZoneBody, response: { 200: z.object({ zone_id: z.string().uuid() }) } } },
    async (request) => {
      const zone_id = await createManualZone(app.db, request.body);
      return { zone_id };
    },
  );

  typedApp.delete(
    "/api/v1/no-strike-zones/:id",
    { schema: { params: ZoneIdParams, response: { 204: z.void(), 404: ErrorResponse } } },
    async (request, reply) => {
      const deleted = await deleteNoStrikeZone(app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "zone not found" });
      return reply.code(204).send();
    },
  );
};

export default blueForceRoutes;
