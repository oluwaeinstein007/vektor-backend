import fp from "fastify-plugin";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Normalizes every error response — expected (`reply.code(404).send({error})`)
 * and unexpected (thrown) — to the same `{error: string}` shape. Previously
 * only expected errors used that shape; an unhandled throw fell through to
 * Fastify's default `{statusCode, error, message}` envelope instead.
 *
 * A 5xx's real message is logged (request.log.error) but never sent to the
 * client, so an unexpected failure doesn't leak internals over the wire.
 */
export const registerDefaultErrorHandler = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((err: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = err.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error(err);
      return reply.code(statusCode).send({ error: "internal server error" });
    }

    return reply.code(statusCode).send({ error: err.message });
  });
});
