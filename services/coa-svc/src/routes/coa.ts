// 07-data-api.md §13.1 — the three COA REST endpoints, all Commander-scoped.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { COA } from "@vektor/shared";
import { listCoasBySituation, getCoaById, decideCoa } from "../db/coaQueries.js";
import { toWireCoa } from "../db/mappers.js";
import type { AuditClient } from "../audit/client.js";

const ErrorResponse = z.object({ error: z.string() });

const SituationIdParams = z.object({ situation_id: z.string().uuid() });
const CoaIdParams = z.object({ coa_id: z.string().uuid() });

// SEC-003 audit fix: actor_user_id/actor_role used to be caller-supplied
// body fields — a client could approve a COA as themselves and have the
// audit log record any actor_role string it liked. Both now come from the
// verified JWT (request.user, populated by requireRole()) instead.
const ApproveBody = z.object({
  option_rank: z.number().int().min(1),
  notes: z.string().nullable().default(null),
});

const RejectBody = z.object({
  reason: z.string().min(1),
});

const coaRoutes: FastifyPluginAsync<{ auditClient: AuditClient }> = async (app, opts) => {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    "/api/v1/coa/:situation_id",
    { preHandler: app.requireRole("commander"), schema: { params: SituationIdParams, response: { 200: z.array(COA) } } },
    async (request) => {
      const rows = await listCoasBySituation(app.db, request.params.situation_id);
      return rows.map(toWireCoa);
    },
  );

  // REQ-4.3: "Approval publishes target package within 2s; full audit
  // trail preserved" — the audit write happens synchronously, before the
  // response returns, so "preserved" isn't racing the HTTP response.
  typedApp.post(
    "/api/v1/coa/:coa_id/approve",
    {
      preHandler: app.requireRole("commander"),
      schema: { params: CoaIdParams, body: ApproveBody, response: { 200: COA, 404: ErrorResponse } },
    },
    async (request, reply) => {
      const row = await decideCoa(app.db, {
        coa_id: request.params.coa_id,
        decision: "APPROVED",
        selected_option: request.body.option_rank,
        notes: request.body.notes,
      });
      if (!row) return reply.code(404).send({ error: "coa not found" });

      await opts.auditClient.write({
        actor_user_id: request.user!.sub,
        actor_role: request.user!.role,
        action: "coa.approve",
        resource_type: "coa",
        resource_id: row.coa_id,
        metadata: { option_rank: request.body.option_rank, notes: request.body.notes },
      });

      return toWireCoa(row);
    },
  );

  typedApp.post(
    "/api/v1/coa/:coa_id/reject",
    {
      preHandler: app.requireRole("commander"),
      schema: { params: CoaIdParams, body: RejectBody, response: { 200: COA, 404: ErrorResponse } },
    },
    async (request, reply) => {
      const row = await decideCoa(app.db, {
        coa_id: request.params.coa_id,
        decision: "REJECTED",
        selected_option: null,
        notes: request.body.reason,
      });
      if (!row) return reply.code(404).send({ error: "coa not found" });

      await opts.auditClient.write({
        actor_user_id: request.user!.sub,
        actor_role: request.user!.role,
        action: "coa.reject",
        resource_type: "coa",
        resource_id: row.coa_id,
        metadata: { reason: request.body.reason },
      });

      return toWireCoa(row);
    },
  );

  // Convenience lookup by coa_id directly — not in 07-data-api.md's table
  // (which only lists the situation_id-keyed GET), but approve/reject
  // responses already return the full COA, so this exists only for a
  // client that has a coa_id without its situation_id (e.g. a deep link).
  typedApp.get(
    "/api/v1/coa/by-id/:coa_id",
    { preHandler: app.requireRole("commander"), schema: { params: CoaIdParams, response: { 200: COA, 404: ErrorResponse } } },
    async (request, reply) => {
      const row = await getCoaById(app.db, request.params.coa_id);
      if (!row) return reply.code(404).send({ error: "coa not found" });
      return toWireCoa(row);
    },
  );
};

export default coaRoutes;
