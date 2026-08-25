import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AuditEntry } from "@vektor/shared";
import { insertAuditEntry, listAuditEntries } from "../db/queries.js";
import { toWireAuditEntry } from "../db/mappers.js";

const WriteAuditBody = z.object({
  actor_user_id: z.string().min(1),
  actor_role: z.string().min(1),
  action: z.string().min(1),
  resource_type: z.string().min(1),
  resource_id: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const AuditQuery = z.object({
  actor_user_id: z.string().optional(),
  action: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const auditRoutes: FastifyPluginAsync = async (app) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // Internal write endpoint — called by every other service after an
  // auditable action (coa.approve, coa.reject, sensor.register,
  // model.upload, ...). Not gated by RbacRole here: RBAC/JWT verification
  // is auth-svc's job (SVC not yet built) at the gateway layer; audit-svc
  // trusts the actor_user_id/actor_role the caller asserts, same as every
  // other service in this phase trusts its caller pending SEC-003.
  typedApp.post(
    "/api/v1/audit",
    { schema: { body: WriteAuditBody, response: { 200: AuditEntry } } },
    async (request) => {
      const row = await insertAuditEntry(app.db, request.body);
      return toWireAuditEntry(row);
    },
  );

  // REQ-8.3 / 07-data-api.md §13.1: GET /api/v1/audit — SuperAdmin only in
  // the PRD's auth column; enforced at the gateway once auth-svc exists.
  typedApp.get(
    "/api/v1/audit",
    { schema: { querystring: AuditQuery, response: { 200: z.array(AuditEntry) } } },
    async (request) => {
      const rows = await listAuditEntries(app.db, {
        actor_user_id: request.query.actor_user_id,
        action: request.query.action,
        from: request.query.from ? new Date(request.query.from) : undefined,
        to: request.query.to ? new Date(request.query.to) : undefined,
        limit: request.query.limit,
      });
      return rows.map(toWireAuditEntry);
    },
  );
};

export default auditRoutes;
