// SVC-010 REST surface — REQ-3.3. No REST spec for this exists in
// 07-data-api.md (no feed in the PRD publishes friendly-asset positions
// automatically; this is an operator-managed registry), so these routes
// follow geospatial-svc's routes/entities.ts pattern: fastify-type-provider-zod
// response schemas as the REQ-9.1 enforcement mechanism.
//
// RBAC (NW-005). §13.1's role table has no row for either resource, so the
// requirement per verb is a documented judgment call, not a spec
// transcription — the same situation sensors/routes.ts's DELETE was in:
//
//   - Writes are `commander`. UC-1.3 ("Declare a No-Strike/No-Interdiction
//     Zone around friendly or protected assets") is explicitly a Commander
//     use case in 01-users-scope.md persona 1. Blue-force asset writes are
//     held to the same bar rather than a lower one: every asset upsert
//     auto-buffers a no-strike zone around it (REQ-3.3), so writing an
//     asset *is* writing a zone by another route. `superadmin` satisfies
//     `commander` already (see packages/auth/src/roles.ts).
//
//   - Reads are `all` (any authenticated role — never unauthenticated).
//     These render on the shared COP map that every role sees, which is
//     the same treatment §13.1 gives /api/v1/alerts and /api/v1/sensors,
//     the closest analogues. Critically, `analyst+` would have been wrong:
//     it excludes Field Operator, and UC-4.1 ("view last-known track
//     positions ... offline") is exactly the dismounted operator needing
//     to know where friendlies are.
//
//     The one open question this leaves is Viewer (persona 6), who can now
//     read friendly-asset positions. If that turns out to be too broad,
//     the fix is a new RoleRequirement in packages/auth (something like
//     "operator+", every role except Viewer) — not a quiet switch to
//     `analyst+`, which would break Field Operator as described above.
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
    { preHandler: app.requireRole("all"), schema: { response: { 200: z.array(BlueForceAsset) } } },
    async () => {
      const rows = await listBlueForceAssets(app.db);
      return rows.map(toWireBlueForceAsset);
    },
  );

  typedApp.post(
    "/api/v1/blue-force-assets",
    { preHandler: app.requireRole("commander"), schema: { body: UpsertAssetBody, response: { 200: BlueForceAsset } } },
    async (request) => {
      const row = await upsertBlueForceAsset(app.db, request.body);
      return toWireBlueForceAsset(row);
    },
  );

  typedApp.put(
    "/api/v1/blue-force-assets/:id",
    {
      preHandler: app.requireRole("commander"),
      schema: { params: AssetIdParams, body: UpsertAssetBody, response: { 200: BlueForceAsset } },
    },
    async (request) => {
      const row = await upsertBlueForceAsset(app.db, { asset_id: request.params.id, ...request.body });
      return toWireBlueForceAsset(row);
    },
  );

  typedApp.delete(
    "/api/v1/blue-force-assets/:id",
    {
      preHandler: app.requireRole("commander"),
      schema: { params: AssetIdParams, response: { 204: z.void(), 404: ErrorResponse } },
    },
    async (request, reply) => {
      const deleted = await deleteBlueForceAsset(app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "asset not found" });
      return reply.code(204).send();
    },
  );

  typedApp.get(
    "/api/v1/no-strike-zones",
    { preHandler: app.requireRole("all"), schema: { response: { 200: z.array(NoStrikeZone) } } },
    async () => {
      const rows = await listNoStrikeZones(app.db);
      return rows.map(toWireNoStrikeZone);
    },
  );

  typedApp.post(
    "/api/v1/no-strike-zones",
    {
      preHandler: app.requireRole("commander"),
      schema: { body: CreateZoneBody, response: { 200: z.object({ zone_id: z.string().uuid() }) } },
    },
    async (request) => {
      const zone_id = await createManualZone(app.db, request.body);
      return { zone_id };
    },
  );

  typedApp.delete(
    "/api/v1/no-strike-zones/:id",
    {
      preHandler: app.requireRole("commander"),
      schema: { params: ZoneIdParams, response: { 204: z.void(), 404: ErrorResponse } },
    },
    async (request, reply) => {
      const deleted = await deleteNoStrikeZone(app.db, request.params.id);
      if (!deleted) return reply.code(404).send({ error: "zone not found" });
      return reply.code(204).send();
    },
  );
};

export default blueForceRoutes;
